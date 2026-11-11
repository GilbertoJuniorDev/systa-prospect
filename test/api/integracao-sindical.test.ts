import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Sem banco: as validações respondem antes de qualquer consulta.
const queryRaw = vi.fn();
vi.mock('../../src/lib/prisma', () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a), $transaction: vi.fn() },
}));

import { integracaoSindicalRoutes } from '../../src/routes/integracao-sindical';
import { isReceitaRoute } from '../../src/lib/base-status';

const KEY = 'chave-sindical-teste';
const AUTH = { 'x-sindical-api-key': KEY };
const CONTAGEM = { cnaes: ['0111301'], uf: 'SP', municipios: ['7107'], situacao: 'ativa' };

describe('rotas de integração do sindical (validação, sem banco)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SINDICAL_API_KEY = KEY;
    app = Fastify();
    await app.register(integracaoSindicalRoutes);
    await app.ready();
  });

  beforeEach(() => {
    queryRaw.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url, headers, payload: payload as object });

  describe.each(['/integracao/sindical/contagem', '/integracao/sindical/empresas'])('%s', (url) => {
    it('sem x-sindical-api-key → 401', async () => {
      const res = await post(url, CONTAGEM, {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('chave errada → 401', async () => {
      const res = await post(url, CONTAGEM, { 'x-sindical-api-key': 'errada' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('GET /integracao/sindical/cnae-divisoes', () => {
    const get = (headers: Record<string, string> = AUTH) =>
      app.inject({ method: 'GET', url: '/integracao/sindical/cnae-divisoes', headers });

    it('sem x-sindical-api-key → 401', async () => {
      const res = await get({});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('chave errada → 401', async () => {
      const res = await get({ 'x-sindical-api-key': 'errada' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  it('contagem com cnae de 6 dígitos → 400', async () => {
    const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, cnaes: ['011130'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('CNAE inválido');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('contagem só aceita situacao ativa ou todas', async () => {
    const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, situacao: 'inativa' });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('contagem sem body → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/integracao/sindical/contagem', headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it('empresas com 501 cnpjs → 400', async () => {
    const cnpjs = Array.from({ length: 501 }, (_, i) => String(10_000_000_000_000 + i));
    const res = await post('/integracao/sindical/empresas', { cnpjs });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Envie de 1 a 500 CNPJs.' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('empresas com lista vazia → 400', async () => {
    const res = await post('/integracao/sindical/empresas', { cnpjs: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Envie de 1 a 500 CNPJs.' });
  });

  it('empresas com cnpj de 13 dígitos → 400', async () => {
    const res = await post('/integracao/sindical/empresas', { cnpjs: ['1234567890123'] });
    expect(res.statusCode).toBe(400);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('isReceitaRoute cobre as rotas de integração (503 em manutenção)', () => {
    expect(isReceitaRoute('/integracao/sindical/contagem')).toBe(true);
    expect(isReceitaRoute('/integracao/sindical/empresas')).toBe(true);
    expect(isReceitaRoute('/integracao/outra')).toBe(false);
  });
});
