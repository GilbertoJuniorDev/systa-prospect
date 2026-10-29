import { describe, it, expect } from 'vitest';
import os from 'os';
import { freeBytes, requiredForZip, requiredForIndex, assertSpace } from '../../src/ingest/disk';
import { DiskSpaceError } from '../../src/ingest/errors';

const GIB = 1024 ** 3;

describe('freeBytes', () => {
  it('returns a positive number for an existing directory', async () => {
    const free = await freeBytes(os.tmpdir());
    expect(typeof free).toBe('number');
    expect(free).toBeGreaterThan(0);
  });
});

describe('requiredForZip', () => {
  it('multiplies by diskFactor and adds minFreeBytes', () => {
    expect(requiredForZip(1e9, { diskFactor: 6, minFreeBytes: 5 * GIB })).toBe(6e9 + 5 * GIB);
  });
});

describe('requiredForIndex', () => {
  it('is ceil(table*1.5) + minFreeBytes', () => {
    expect(requiredForIndex(1001, { minFreeBytes: 5 * GIB })).toBe(Math.ceil(1001 * 1.5) + 5 * GIB);
    expect(requiredForIndex(2e9, { minFreeBytes: 0 })).toBe(3e9);
  });
});

describe('assertSpace', () => {
  it('throws DiskSpaceError with the exact message', () => {
    expect(() => assertSpace(10e9, 12.34e9, 'Empresas0.zip')).toThrow(
      'espaço insuficiente: 10.0 GB livres, 12.3 GB necessários para Empresas0.zip',
    );
    expect(() => assertSpace(10e9, 12.34e9, 'Empresas0.zip')).toThrow(DiskSpaceError);
  });

  it('does not throw when free >= required', () => {
    expect(() => assertSpace(12e9, 12e9, 'x')).not.toThrow();
    expect(() => assertSpace(13e9, 12e9, 'x')).not.toThrow();
  });
});
