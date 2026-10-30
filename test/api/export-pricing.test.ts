import { describe, it, expect } from 'vitest';
import { exportPricing } from '../../src/lib/export-pricing';

describe('exportPricing', () => {
  it('full export without cache', () => {
    expect(exportPricing(95, null)).toEqual({ cost: 95, kind: 'full' });
    expect(exportPricing(3, null)).toEqual({ cost: 3, kind: 'full' });
  });
  it('diff when total grew since cache', () => {
    expect(exportPricing(120, { total: 100 })).toEqual({ cost: 20, kind: 'diff' });
    expect(exportPricing(101, { total: 100 })).toEqual({ cost: 1, kind: 'diff' });
  });
  it('free when total did not grow', () => {
    expect(exportPricing(100, { total: 100 })).toEqual({ cost: 0, kind: 'free' });
    expect(exportPricing(80, { total: 100 })).toEqual({ cost: 0, kind: 'free' });
  });
});
