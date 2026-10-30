import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunDeps } from '../../src/ingest/run';

vi.mock('../../src/ingest/state', () => ({
  getLastSuccess: vi.fn(),
  getOpenRun: vi.fn(),
  createRun: vi.fn(),
  abandonRun: vi.fn(),
  bootstrapIfNeeded: vi.fn(),
}));

import { bootstrapOutcome, createBootstrapGuard, tick } from '../../src/ingest/scheduler';
import { PermanentError } from '../../src/ingest/errors';
import { abandonRun, bootstrapIfNeeded, createRun, getLastSuccess, getOpenRun } from '../../src/ingest/state';
import type { Notifier } from '../../src/ingest/notify';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeDeps(opts: { locked?: boolean; remote?: string[] | Error } = {}) {
  const queries: string[] = [];
  const db = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [{ locked: opts.locked ?? true }] };
    }),
  };
  const remote = opts.remote ?? ['2026-10'];
  const listRemoteMonths = vi.fn(async () => {
    if (remote instanceof Error) throw remote;
    return remote;
  });
  const executeRun = vi.fn(async () => {});
  const deps = {
    cfg: {} as RunDeps['cfg'],
    prisma: {} as RunDeps['prisma'],
    db,
    log: vi.fn(),
    listRemoteMonths,
    executeRun,
  } as unknown as RunDeps & { listRemoteMonths: typeof listRemoteMonths; executeRun: typeof executeRun };
  return { deps, db, queries, listRemoteMonths, executeRun };
}

beforeEach(() => {
  vi.mocked(getLastSuccess).mockReset().mockResolvedValue({ month: '2026-09', finishedAt: new Date() });
  vi.mocked(getOpenRun).mockReset().mockResolvedValue(null);
  vi.mocked(createRun).mockReset().mockResolvedValue('run-new');
  vi.mocked(abandonRun).mockReset().mockResolvedValue(undefined);
});

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('tick', () => {
  it('lock held → none without listing', async () => {
    const { deps, listRemoteMonths, executeRun, queries } = makeDeps({ locked: false });
    const { decision: d, runId } = await tick('daily', deps);
    expect(d.kind).toBe('none');
    expect(runId).toBeUndefined();
    expect(listRemoteMonths).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('remote listing failure on daily → none', async () => {
    const { deps, executeRun, queries } = makeDeps({ remote: new Error('boom') });
    const { decision: d, runId } = await tick('daily', deps);
    expect(d.kind).toBe('none');
    expect(executeRun).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('pg_advisory_unlock(727011)'))).toBe(true);
  });

  it('new month → createRun then executeRun, lock released', async () => {
    const { deps, executeRun, queries } = makeDeps({ remote: ['2026-09', '2026-10'] });
    const { decision: d, runId } = await tick('daily', deps);
    expect(d).toEqual({ kind: 'start', month: '2026-10' });
    expect(runId).toBe('run-new');
    expect(createRun).toHaveBeenCalledWith(deps.prisma, '2026-10');
    expect(executeRun).toHaveBeenCalledWith('run-new', deps);
    expect(queries[queries.length - 1]).toContain('pg_advisory_unlock(727011)');
  });

  it('start abandons old run', async () => {
    vi.mocked(getOpenRun).mockResolvedValue({
      id: 'old', month: '2026-09', status: 'FAILED', errorKind: 'TEMPORARY', finishedAt: new Date(),
    });
    const order: string[] = [];
    vi.mocked(abandonRun).mockImplementation(async () => { order.push('abandon'); });
    vi.mocked(createRun).mockImplementation(async () => { order.push('create'); return 'run-new'; });
    const { deps, executeRun } = makeDeps({ remote: ['2026-10'] });
    const { decision: d, runId } = await tick('daily', deps);
    expect(d).toEqual({ kind: 'start', month: '2026-10', abandonRunId: 'old' });
    expect(abandonRun).toHaveBeenCalledWith(deps.prisma, 'old');
    expect(order).toEqual(['abandon', 'create']);
    expect(executeRun).toHaveBeenCalledWith('run-new', deps);
  });

  it('startup resumes RUNNING without listing remote', async () => {
    vi.mocked(getOpenRun).mockResolvedValue({
      id: 'r1', month: '2026-10', status: 'RUNNING', errorKind: null, finishedAt: null,
    });
    const { deps, executeRun, listRemoteMonths } = makeDeps();
    const { decision: d, runId } = await tick('startup', deps);
    expect(d).toEqual({ kind: 'resume', runId: 'r1' });
    expect(runId).toBe('r1');
    expect(executeRun).toHaveBeenCalledWith('r1', deps);
    expect(listRemoteMonths).not.toHaveBeenCalled();
  });

  it('manual with forced month starts it and releases lock even if executeRun throws', async () => {
    const { deps, executeRun, queries } = makeDeps();
    executeRun.mockRejectedValue(new Error('x'));
    await expect(tick('manual', deps, '2026-08')).rejects.toThrow('x');
    expect(createRun).toHaveBeenCalledWith(deps.prisma, '2026-08');
    expect(queries[queries.length - 1]).toContain('pg_advisory_unlock(727011)');
  });
});

describe('createBootstrapGuard', () => {
  function setup(count: number) {
    const runs = { count };
    const prisma = { ingestRun: { count: vi.fn(async () => runs.count) } } as unknown as RunDeps['prisma'];
    const notifier = {
      started: vi.fn(),
      succeeded: vi.fn(),
      failed: vi.fn(async () => {}),
      bootstrapFailed: vi.fn(async () => {}),
    } satisfies Notifier;
    const guard = createBootstrapGuard({ prisma, cfg: {} as RunDeps['cfg'], notifier, log: vi.fn() });
    return { runs, guard, notifier };
  }

  beforeEach(() => {
    vi.mocked(bootstrapIfNeeded).mockReset();
  });

  it('permanent failure sends the dedicated bootstrap e-mail once and blocks', async () => {
    vi.mocked(bootstrapIfNeeded).mockImplementation(async () => {
      throw new PermanentError('INGEST_MONTH obrigatório');
    });
    const { guard, notifier } = setup(0);
    await guard.ensure();
    await guard.ensure();
    expect(guard.failed()).toBe(true);
    expect(notifier.bootstrapFailed).toHaveBeenCalledTimes(1);
    expect(notifier.bootstrapFailed).toHaveBeenCalledWith('INGEST_MONTH obrigatório');
    expect(notifier.failed).not.toHaveBeenCalled();
  });

  it('clears the failure once IngestRun has rows (e.g. ingest:now ran)', async () => {
    vi.mocked(bootstrapIfNeeded).mockImplementation(async () => {
      throw new PermanentError('INGEST_MONTH obrigatório');
    });
    const { runs, guard } = setup(0);
    await guard.ensure();
    expect(guard.failed()).toBe(true);
    runs.count = 1;
    await guard.ensure();
    expect(guard.failed()).toBe(false);
    expect(bootstrapIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('retryable errors propagate and are tried again next cycle', async () => {
    vi.mocked(bootstrapIfNeeded).mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined);
    const { guard } = setup(0);
    await expect(guard.ensure()).rejects.toThrow('db down');
    expect(guard.failed()).toBe(false);
    await guard.ensure();
    await guard.ensure();
    expect(bootstrapIfNeeded).toHaveBeenCalledTimes(2);
  });
});

describe('bootstrapOutcome', () => {
  it('PermanentError → permanent', () => {
    expect(bootstrapOutcome(new PermanentError('INGEST_MONTH obrigatório'))).toBe('permanent');
  });

  it('generic error → retry', () => {
    expect(bootstrapOutcome(new Error('connection refused'))).toBe('retry');
    expect(bootstrapOutcome('string error')).toBe('retry');
  });
});
