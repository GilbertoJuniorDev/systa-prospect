import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../src/lib/prisma', () => ({ prisma: {} }));
const latestRunStatus = vi.fn();
vi.mock('../../src/ingest/state', () => ({ latestRunStatus: (...a: unknown[]) => latestRunStatus(...a) }));

import {
  getBaseStatus,
  resetBaseStatusCache,
  isReceitaRoute,
  cacheNotice,
  formatBaseDate,
  MAINTENANCE_BODY,
  maintenanceHook,
} from '../../src/lib/base-status';

describe('isReceitaRoute', () => {
  it('matches Receita routes, ignoring query string', () => {
    expect(isReceitaRoute('/consulta?x=1')).toBe(true);
    expect(isReceitaRoute('/consulta/exportar')).toBe(true);
    expect(isReceitaRoute('/cnpj/123')).toBe(true);
    expect(isReceitaRoute('/empresas')).toBe(true);
    expect(isReceitaRoute('/empresas/buscar?nome=abc')).toBe(true);
    expect(isReceitaRoute('/empresas/cnae/1234567')).toBe(true);
    expect(isReceitaRoute('/cnaes/buscar?q=ab')).toBe(true);
    expect(isReceitaRoute('/municipios?uf=SP')).toBe(true);
  });
  it('does not match the rest', () => {
    expect(isReceitaRoute('/consultas/minhas')).toBe(false);
    expect(isReceitaRoute('/stripe/webhook')).toBe(false);
    expect(isReceitaRoute('/health')).toBe(false);
    expect(isReceitaRoute('/base/status')).toBe(false);
    expect(isReceitaRoute('/auth/login')).toBe(false);
    expect(isReceitaRoute('/user/credits')).toBe(false);
    expect(isReceitaRoute('/empresasx')).toBe(false);
    expect(isReceitaRoute('/municipiosx')).toBe(false);
  });
});

describe('cacheNotice', () => {
  const base = { month: '2026-10', loadedAt: new Date('2026-10-29T12:00:00Z'), maintenance: false };
  it('flags stale cache with notice', () => {
    expect(cacheNotice(new Date('2026-10-01T00:00:00Z'), base)).toEqual({
      baseDesatualizada: true,
      aviso: 'A base da Receita foi atualizada em 29/10/2026 (mês 2026-10). Os números desta consulta podem estar defasados.',
    });
  });
  it('does not flag fresh cache', () => {
    expect(cacheNotice(new Date('2026-10-30T00:00:00Z'), base)).toEqual({ baseDesatualizada: false, aviso: null });
  });
  it('does not flag after bootstrap (month known, loadedAt null)', () => {
    expect(cacheNotice(new Date('2020-01-01T00:00:00Z'), { month: '2026-06', loadedAt: null, maintenance: false })).toEqual({
      baseDesatualizada: false,
      aviso: null,
    });
  });
  it('does not flag when no base loaded', () => {
    expect(cacheNotice(new Date(), { month: null, loadedAt: null, maintenance: false })).toEqual({
      baseDesatualizada: false,
      aviso: null,
    });
  });
});

describe('formatBaseDate', () => {
  it('formats dd/mm/aaaa in America/Sao_Paulo', () => {
    expect(formatBaseDate(new Date('2026-10-30T01:00:00Z'))).toBe('29/10/2026');
  });
});

describe('MAINTENANCE_BODY', () => {
  it('is exact', () => {
    expect(MAINTENANCE_BODY).toEqual({
      error: 'Servidor em manutenção: atualização da base da Receita Federal em andamento.',
      code: 'maintenance',
    });
  });
});

describe('getBaseStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    resetBaseStatusCache();
    latestRunStatus.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('caches for 30 s', async () => {
    latestRunStatus.mockResolvedValue({ month: '2026-10', loadedAt: null, maintenance: true });
    expect((await getBaseStatus()).maintenance).toBe(true);
    await getBaseStatus();
    expect(latestRunStatus).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    latestRunStatus.mockResolvedValue({ month: '2026-10', loadedAt: null, maintenance: false });
    expect((await getBaseStatus()).maintenance).toBe(false);
    expect(latestRunStatus).toHaveBeenCalledTimes(2);
  });

  it('falls back to last known value on DB error', async () => {
    latestRunStatus.mockResolvedValueOnce({ month: '2026-09', loadedAt: null, maintenance: true });
    await getBaseStatus();
    vi.advanceTimersByTime(30_001);
    latestRunStatus.mockRejectedValueOnce(new Error('db down'));
    expect(await getBaseStatus()).toEqual({ month: '2026-09', loadedAt: null, maintenance: true });
  });

  it('falls back to empty status when no known value', async () => {
    latestRunStatus.mockRejectedValueOnce(new Error('db down'));
    expect(await getBaseStatus()).toEqual({ month: null, loadedAt: null, maintenance: false });
  });
});

describe('isReceitaRoute with route patterns', () => {
  it('accepts Fastify route patterns', () => {
    expect(isReceitaRoute('/empresas/:cnpj_base')).toBe(true);
    expect(isReceitaRoute('/empresas/cnae/:codigo')).toBe(true);
    expect(isReceitaRoute('/cnpj/:cnpj')).toBe(true);
    expect(isReceitaRoute('/consulta/exportar')).toBe(true);
    expect(isReceitaRoute('/consultas/minhas')).toBe(false);
  });
  it('unmatched route (404) → false', () => {
    expect(isReceitaRoute(undefined)).toBe(false);
  });
});

describe('maintenanceHook', () => {
  beforeEach(() => {
    resetBaseStatusCache();
    latestRunStatus.mockReset().mockResolvedValue({ month: '2026-10', loadedAt: null, maintenance: true });
  });

  async function makeApp() {
    const app = Fastify();
    app.addHook('onRequest', maintenanceHook);
    app.get('/cnpj/:cnpj', async () => ({ ok: true }));
    app.get('/base/status', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('uses the route pattern: /cnpj/:cnpj blocked with 503 during maintenance', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/cnpj/12345678000199?x=1' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1800');
    expect(res.json()).toEqual(MAINTENANCE_BODY);
    await app.close();
  });

  it('does not block non-Receita routes nor unknown URLs (404)', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/base/status' })).statusCode).toBe(200);
    // URL "parecida" com rota da Receita, mas sem rota registrada: 404, não 503.
    expect((await app.inject({ method: 'GET', url: '/empresas/qualquer' })).statusCode).toBe(404);
    await app.close();
  });
});
