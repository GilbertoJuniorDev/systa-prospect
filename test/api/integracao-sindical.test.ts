import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Sem banco: as validações respondem antes de qualquer consulta.
const queryRaw = vi.fn();
const transaction = vi.fn();
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    $transaction: (...a: unknown[]) => transaction(...a),
  },
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
    transaction.mockReset();
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

  describe('POST /integracao/sindical/cnaes/descricoes', () => {
    const URL = '/integracao/sindical/cnaes/descricoes';
    const codigos = (n: number) => Array.from({ length: n }, (_, i) => String(1_000_000 + i));

    it('sem x-sindical-api-key → 401', async () => {
      const res = await post(URL, { cnaes: ['0111301'] }, {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnaes vazio → 400', async () => {
      const res = await post(URL, { cnaes: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Envie de 1 a 100 CNAEs.' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('101 cnaes → 400', async () => {
      const res = await post(URL, { cnaes: codigos(101) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Envie de 1 a 100 CNAEs.' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnaes que não é array → 400', async () => {
      const res = await post(URL, { cnaes: '0111301' });
      expect(res.statusCode).toBe(400);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnae com 3 dígitos → 400', async () => {
      const res = await post(URL, { cnaes: ['123'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('CNAE inválido');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('100 cnaes válidos passam da validação', async () => {
      queryRaw.mockResolvedValue([]);
      const res = await post(URL, { cnaes: codigos(100) });
      expect(res.statusCode).toBe(200);
      expect(res.json().dados).toHaveLength(100);
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

  describe('contagem: divisoes e mei (validação)', () => {
    const contagemSem = (extra: object) => {
      const { cnaes: _cnaes, ...resto } = CONTAGEM;
      return { ...resto, ...extra };
    };

    it.each([['4'], ['047'], ['ab'], ['04']])('divisão %s inválida → 400', async (codigo) => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, divisoes: [codigo] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Divisão inválida');
      expect(queryRaw).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('divisão repetida → 400', async () => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, divisoes: ['47', '47'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Divisão repetida');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('divisoes que não é array → 400', async () => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, divisoes: '47' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('divisoes');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('mei inválido → 400', async () => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, mei: 'talvez' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Campo "mei"');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnaes e divisoes vazios → 400', async () => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, cnaes: [], divisoes: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Informe ao menos um CNAE ou uma divisão.');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnae avulso malformado com divisão → 400 antes de consultar o banco', async () => {
      const res = await post('/integracao/sindical/contagem', { ...CONTAGEM, cnaes: ['011130'], divisoes: ['47'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('CNAE inválido');
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('cnaes ausente com divisoes é aceito (sem 400 de validação)', async () => {
      queryRaw.mockResolvedValue([{ codigo: '4711301' }]);
      transaction.mockResolvedValue([]);
      const res = await post('/integracao/sindical/contagem', contagemSem({ divisoes: ['47'] }));
      expect(res.statusCode).not.toBe(400);
    });
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
