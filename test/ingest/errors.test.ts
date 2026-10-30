import { describe, it, expect } from 'vitest';
import {
  classifyError,
  TemporaryError,
  PermanentError,
  DiskSpaceError,
  HttpError,
} from '../../src/ingest/errors';

describe('error classes', () => {
  it('set name and inheritance', () => {
    expect(new TemporaryError('x')).toBeInstanceOf(Error);
    expect(new TemporaryError('x').name).toBe('TemporaryError');
    expect(new PermanentError('x').name).toBe('PermanentError');
    expect(new DiskSpaceError('x')).toBeInstanceOf(PermanentError);
    expect(new DiskSpaceError('x').name).toBe('DiskSpaceError');
    const h = new HttpError(503, 'x');
    expect(h).toBeInstanceOf(Error);
    expect(h.name).toBe('HttpError');
    expect(h.status).toBe(503);
    expect(h.message).toBe('x');
  });
});

describe('classifyError', () => {
  it.each([
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'TEMPORARY'],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'TEMPORARY'],
    [Object.assign(new Error('x'), { code: 'EAI_AGAIN' }), 'TEMPORARY'],
    [Object.assign(new Error('x'), { code: '57P03' }), 'TEMPORARY'],
    [Object.assign(new Error('x'), { code: '08006' }), 'TEMPORARY'],
    [new HttpError(503, 'x'), 'TEMPORARY'],
    [new HttpError(429, 'x'), 'TEMPORARY'],
    [new HttpError(404, 'x'), 'PERMANENT'],
    [new HttpError(401, 'x'), 'PERMANENT'],
    [Object.assign(new Error('x'), { code: '53100' }), 'PERMANENT'],
    [new DiskSpaceError('x'), 'PERMANENT'],
    [new TemporaryError('x'), 'TEMPORARY'],
    [new Error('qualquer'), 'PERMANENT'],
  ])('classify %#', (e, k) => expect(classifyError(e)).toBe(k));

  it('treats socket hang up message as temporary', () =>
    expect(classifyError(new Error('socket hang up'))).toBe('TEMPORARY'));

  it.each([
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03',
    '08003', // connection_does_not_exist
    '08P01', // protocol_violation (classe 08)
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'P1001',
    'P1002',
    'P1008',
    'P1017',
  ])('db restart / network code %s is temporary', (code) =>
    expect(classifyError(Object.assign(new Error('x'), { code }))).toBe('TEMPORARY'));

  it('reads Prisma errorCode too', () => {
    expect(classifyError(Object.assign(new Error('x'), { errorCode: 'P1001' }))).toBe('TEMPORARY');
    expect(classifyError(Object.assign(new Error('x'), { errorCode: 'P2002' }))).toBe('PERMANENT');
  });

  it('treats PrismaClientInitializationError as temporary', () => {
    const e = new Error("Can't reach database server");
    e.name = 'PrismaClientInitializationError';
    expect(classifyError(e)).toBe('TEMPORARY');
  });

  it('treats terminated connections as temporary', () => {
    expect(classifyError(new Error('Connection terminated'))).toBe('TEMPORARY');
    expect(classifyError(new Error('Connection terminated unexpectedly'))).toBe('TEMPORARY');
  });

  it('looks into err.cause once', () => {
    const cause = Object.assign(new Error('x'), { code: '57P01' });
    expect(classifyError(new Error('wrapper', { cause }))).toBe('TEMPORARY');
    const deep = new Error('w1', { cause: new Error('w2', { cause }) });
    expect(classifyError(deep)).toBe('PERMANENT');
    expect(classifyError(new Error('wrapper', { cause: new Error('qualquer') }))).toBe('PERMANENT');
  });

  it('keeps explicit PermanentError permanent even with a temporary cause', () =>
    expect(classifyError(new PermanentError('x'))).toBe('PERMANENT'));

  it('handles non-error values as permanent', () => {
    expect(classifyError(undefined)).toBe('PERMANENT');
    expect(classifyError('boom')).toBe('PERMANENT');
    expect(classifyError(null)).toBe('PERMANENT');
  });
});
