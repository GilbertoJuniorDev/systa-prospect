import { describe, it, expect } from 'vitest';
import { decideNext, latestMonth, nextDailyRun, nextWakeUp } from '../../src/ingest/decide';

const failedTemp = {
  id: 'r1',
  month: '2026-09',
  status: 'FAILED',
  errorKind: 'TEMPORARY',
  finishedAt: new Date('2026-10-01T06:00:00Z'),
} as const;

describe('decideNext', () => {
  it('daily starts new remote month', () => {
    expect(decideNext({ trigger: 'daily', lastSuccessMonth: '2026-09', openRun: null, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-10' });
  });
  it('daily does nothing when up to date', () => {
    expect(decideNext({ trigger: 'daily', lastSuccessMonth: '2026-10', openRun: null, latestRemote: '2026-10' }).kind).toBe('none');
  });
  it('daily starts when never succeeded', () => {
    expect(decideNext({ trigger: 'daily', lastSuccessMonth: null, openRun: null, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-10' });
  });
  it('daily does nothing when remote is unknown', () => {
    expect(decideNext({ trigger: 'daily', lastSuccessMonth: '2026-09', openRun: null, latestRemote: null }).kind).toBe('none');
  });
  it('startup without RUNNING does nothing', () => {
    expect(decideNext({ trigger: 'startup', lastSuccessMonth: '2026-09', openRun: null, latestRemote: '2026-10' }).kind).toBe('none');
  });
  it('startup resumes RUNNING run', () => {
    expect(decideNext({ trigger: 'startup', lastSuccessMonth: '2026-09', openRun: { ...failedTemp, status: 'RUNNING' }, latestRemote: null })).toEqual({ kind: 'resume', runId: 'r1' });
  });
  it('startup does not touch FAILED run', () => {
    expect(decideNext({ trigger: 'startup', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: '2026-09' }).kind).toBe('none');
  });
  it('retry resumes TEMPORARY failure', () => {
    expect(decideNext({ trigger: 'retry', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: '2026-09' })).toEqual({ kind: 'resume', runId: 'r1' });
  });
  it('retry skips PERMANENT failure', () => {
    expect(decideNext({ trigger: 'retry', lastSuccessMonth: '2026-08', openRun: { ...failedTemp, errorKind: 'PERMANENT' }, latestRemote: '2026-09' }).kind).toBe('none');
  });
  it('daily resumes PERMANENT failure', () => {
    expect(decideNext({ trigger: 'daily', lastSuccessMonth: '2026-08', openRun: { ...failedTemp, errorKind: 'PERMANENT' }, latestRemote: '2026-09' })).toEqual({ kind: 'resume', runId: 'r1' });
  });
  it('newer remote month abandons failed run', () => {
    expect(decideNext({ trigger: 'retry', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-10', abandonRunId: 'r1' });
  });
  it('failed run with unknown remote resumes', () => {
    expect(decideNext({ trigger: 'retry', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: null })).toEqual({ kind: 'resume', runId: 'r1' });
  });
  it('manual with forcedMonth starts that month', () => {
    expect(decideNext({ trigger: 'manual', forcedMonth: '2026-07', lastSuccessMonth: '2026-09', openRun: null, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-07' });
  });
  it('manual with forcedMonth abandons open run of another month', () => {
    expect(decideNext({ trigger: 'manual', forcedMonth: '2026-07', lastSuccessMonth: '2026-09', openRun: failedTemp, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-07', abandonRunId: 'r1' });
  });
  it('manual with forcedMonth resumes open run of same month', () => {
    expect(decideNext({ trigger: 'manual', forcedMonth: '2026-09', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: '2026-10' })).toEqual({ kind: 'resume', runId: 'r1' });
  });
  it('manual without forcedMonth behaves like daily', () => {
    expect(decideNext({ trigger: 'manual', lastSuccessMonth: '2026-09', openRun: null, latestRemote: '2026-10' })).toEqual({ kind: 'start', month: '2026-10' });
    expect(decideNext({ trigger: 'manual', lastSuccessMonth: '2026-08', openRun: failedTemp, latestRemote: '2026-09' })).toEqual({ kind: 'resume', runId: 'r1' });
  });
});

describe('latestMonth', () => {
  it('picks the greatest valid month folder', () => {
    expect(latestMonth(['2026-09', '2026-10', 'temp', '2025-12', '2026-1'])).toBe('2026-10');
  });
  it('returns null when none valid', () => {
    expect(latestMonth(['temp', 'x'])).toBeNull();
    expect(latestMonth([])).toBeNull();
  });
});

describe('nextDailyRun', () => {
  it('returns same-day run when before the hour', () => {
    expect(nextDailyRun(new Date('2026-10-29T04:59:00Z'), 2, 'America/Sao_Paulo').toISOString()).toBe('2026-10-29T05:00:00.000Z');
  });
  it('is strictly after now', () => {
    expect(nextDailyRun(new Date('2026-10-29T05:00:00Z'), 2, 'America/Sao_Paulo').toISOString()).toBe('2026-10-30T05:00:00.000Z');
  });
  it('works in UTC regardless of host timezone', () => {
    expect(nextDailyRun(new Date('2026-10-29T03:30:00Z'), 2, 'UTC').toISOString()).toBe('2026-10-30T02:00:00.000Z');
  });
});

describe('nextWakeUp', () => {
  const daily = new Date('2026-10-30T05:00:00Z');
  it('retry wins when sooner', () => {
    expect(nextWakeUp(new Date('2026-10-29T06:10:00Z'), daily, { ...failedTemp, finishedAt: new Date('2026-10-29T06:00:00Z') })).toEqual({ at: new Date('2026-10-29T06:30:00Z'), trigger: 'retry' });
  });
  it('daily when no open run', () => {
    expect(nextWakeUp(new Date('2026-10-29T06:10:00Z'), daily, null)).toEqual({ at: daily, trigger: 'daily' });
  });
  it('ignores PERMANENT failures', () => {
    expect(nextWakeUp(new Date('2026-10-29T06:10:00Z'), daily, { ...failedTemp, errorKind: 'PERMANENT' })).toEqual({ at: daily, trigger: 'daily' });
  });
});
