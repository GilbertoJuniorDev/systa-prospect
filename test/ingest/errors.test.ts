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

  it('handles non-error values as permanent', () => {
    expect(classifyError(undefined)).toBe('PERMANENT');
    expect(classifyError('boom')).toBe('PERMANENT');
    expect(classifyError(null)).toBe('PERMANENT');
  });
});
