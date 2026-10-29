import { describe, it, expect } from 'vitest';
import path from 'path';
import { loadIngestConfig } from '../../src/ingest/config';

const base = { SHARE_TOKEN: 't', DATABASE_URL: 'x' };

describe('loadIngestConfig', () => {
  it('defaults', () => {
    const c = loadIngestConfig({ SHARE_TOKEN: 't', DATABASE_URL: 'x' });
    expect(c.cronHour).toBe(2);
    expect(c.timeZone).toBe('America/Sao_Paulo');
    expect(c.diskFactor).toBe(6);
    expect(c.minFreeBytes).toBe(5 * 1024 ** 3);
    expect(c.bootstrapMonth).toBeNull();
    expect(c.notifyEmails).toEqual([]);
    expect(c.tempDir).toBe(path.resolve('./temp'));
    expect(c.shareToken).toBe('t');
    expect(c.databaseUrl).toBe('x');
  });

  it('reads TZ, cron hour, month, disk factor and min free GB', () => {
    const c = loadIngestConfig({
      ...base,
      TZ: 'UTC',
      INGEST_CRON_HOUR: '5',
      INGEST_MONTH: '2026-03',
      INGEST_DISK_FACTOR: '4.5',
      INGEST_MIN_FREE_GB: '10',
    });
    expect(c.timeZone).toBe('UTC');
    expect(c.cronHour).toBe(5);
    expect(c.bootstrapMonth).toBe('2026-03');
    expect(c.diskFactor).toBe(4.5);
    expect(c.minFreeBytes).toBe(10 * 1024 ** 3);
  });

  it('treats empty INGEST_MONTH as null', () => {
    expect(loadIngestConfig({ ...base, INGEST_MONTH: '' }).bootstrapMonth).toBeNull();
  });

  it('splits emails', () =>
    expect(
      loadIngestConfig({ ...base, INGEST_NOTIFY_EMAIL: ' a@x.com, b@y.com ' }).notifyEmails,
    ).toEqual(['a@x.com', 'b@y.com']));

  it('rejects missing SHARE_TOKEN', () =>
    expect(() => loadIngestConfig({ DATABASE_URL: 'x' })).toThrow());

  it('rejects missing DATABASE_URL', () =>
    expect(() => loadIngestConfig({ SHARE_TOKEN: 't' })).toThrow());

  it('rejects bad month', () =>
    expect(() => loadIngestConfig({ ...base, INGEST_MONTH: '2026-13' })).toThrow());

  it('rejects bad hour', () =>
    expect(() => loadIngestConfig({ ...base, INGEST_CRON_HOUR: '24' })).toThrow());

  it('rejects non-numeric hour', () =>
    expect(() => loadIngestConfig({ ...base, INGEST_CRON_HOUR: 'abc' })).toThrow());

  it('rejects non-positive disk factor', () => {
    expect(() => loadIngestConfig({ ...base, INGEST_DISK_FACTOR: '0' })).toThrow();
    expect(() => loadIngestConfig({ ...base, INGEST_DISK_FACTOR: '-1' })).toThrow();
    expect(() => loadIngestConfig({ ...base, INGEST_DISK_FACTOR: 'abc' })).toThrow();
  });

  it('rejects non-positive min free GB', () => {
    expect(() => loadIngestConfig({ ...base, INGEST_MIN_FREE_GB: '0' })).toThrow();
    expect(() => loadIngestConfig({ ...base, INGEST_MIN_FREE_GB: 'NaN' })).toThrow();
  });
});
