import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// MAX_EXPORT_ROWS é lido na importação do módulo de rotas; precisa valer antes dela.
vi.hoisted(() => {
  process.env.MAX_EXPORT_ROWS = '2';
});

const url = process.env.TEST_DATABASE_URL;

vi.mock('../../src/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  return { prisma: new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL }) };
});

import { prisma } from '../../src/lib/prisma';
import { integracaoSindicalRoutes } from '../../src/routes/integracao-sindical';
import { resetBaseStatusCache } from '../../src/lib/base-status';

const KEY = 'chave-sindical-teste';
const AUTH = { 'x-sindical-api-key': KEY };

describe.skipIf(!url)('contagem: teto de registros (integração)', () => {
  let app: FastifyInstance;

  async function insertEstab(base: string) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Estabelecimento"
         (cnpj_base, cnpj_ordem, cnpj_dv, identificador_matriz_filial, situacao_cadastral,
          cnae_fiscal_principal, uf, municipio, data_inicio_atividade)
       VALUES ($1, '0001', '55', '1', '02', '0111301', 'SP', '7107', '20150310')`,
      base,
    );
  }

  async function cleanup() {
    await prisma.$executeRawUnsafe('TRUNCATE "Estabelecimento", "Empresa", "Cnae", "Municipio", "IngestRun", "Simples" CASCADE');
  }

  beforeAll(async () => {
    process.env.SINDICAL_API_KEY = KEY;
    app = Fastify();
    await app.register(integracaoSindicalRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    await cleanup();
    resetBaseStatusCache();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  const contagem = () =>
    app.inject({
      method: 'POST',
      url: '/integracao/sindical/contagem',
      headers: AUTH,
      payload: { cnaes: ['0111301'], uf: 'SP', municipios: ['7107'], situacao: 'ativa' },
    });

  it('no teto exato responde 200 com todos os itens', async () => {
    await insertEstab('30000001');
    await insertEstab('30000002');

    const res = await contagem();

    expect(res.statusCode).toBe(200);
    expect(res.json().itens).toHaveLength(2);
  });

  it('acima do teto responde 400 com o total real (não o corte do LIMIT)', async () => {
    for (const base of ['30000001', '30000002', '30000003', '30000004', '30000005']) {
      await insertEstab(base);
    }

    const res = await contagem();

    expect(res.statusCode).toBe(400);
    expect(res.json().total).toBe(5);
    expect(res.json().error).toContain('Limite máximo');
  });
});
