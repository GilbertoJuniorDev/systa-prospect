import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunDeps } from '../../src/ingest/run';

vi.mock('../../src/ingest/state', () => ({
  getLastSuccess: vi.fn(),
  getOpenRun: vi.fn(),
  createRun: vi.fn(),
  abandonRun: vi.fn(),
}));

import { tick } from '../../src/ingest/scheduler';
import { abandonRun, createRun, getLastSuccess, getOpenRun } from '../../src/ingest/state';

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
    const d = await tick('daily', deps);
    expect(d.kind).toBe('none');
    expect(listRemoteMonths).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('remote listing failure on daily → none', async () => {
    const { deps, executeRun, queries } = makeDeps({ remote: new Error('boom') });
    const d = await tick('daily', deps);
    expect(d.kind).toBe('none');
    expect(executeRun).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('pg_advisory_unlock(727011)'))).toBe(true);
  });

  it('new month → createRun then executeRun, lock released', async () => {
    const { deps, executeRun, queries } = makeDeps({ remote: ['2026-09', '2026-10'] });
    const d = await tick('daily', deps);
    expect(d).toEqual({ kind: 'start', month: '2026-10' });
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
    const d = await tick('daily', deps);
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
    const d = await tick('startup', deps);
    expect(d).toEqual({ kind: 'resume', runId: 'r1' });
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
