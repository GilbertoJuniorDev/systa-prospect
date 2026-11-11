import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const url = process.env.TEST_DATABASE_URL;

// Prisma da API apontando para o banco de testes.
vi.mock('../../src/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  return { prisma: new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL }) };
});

import { prisma } from '../../src/lib/prisma';
import { integracaoSindicalRoutes } from '../../src/routes/integracao-sindical';
import { resetBaseStatusCache } from '../../src/lib/base-status';

const KEY = 'chave-sindical-teste';
const AUTH = { 'x-sindical-api-key': KEY };

describe.skipIf(!url)('rotas de integração do sindical (integração)', () => {
  let app: FastifyInstance;

  async function insertEstab(base: string, municipio: string, situacao: string, extra: { ddd1?: string; tel1?: string } = {}) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Estabelecimento"
         (cnpj_base, cnpj_ordem, cnpj_dv, identificador_matriz_filial, situacao_cadastral,
          cnae_fiscal_principal, uf, municipio, data_inicio_atividade, ddd1, telefone1, correio_eletronico)
       VALUES ($1, '0001', '55', '1', $2, '0111301', 'SP', $3, '20150310', $4, $5, 'contato@teste.com')`,
      base, situacao, municipio, extra.ddd1 ?? null, extra.tel1 ?? null,
    );
  }

  async function cleanup() {
    await prisma.$executeRawUnsafe('TRUNCATE "Estabelecimento", "Empresa", "Cnae", "Municipio", "IngestRun" CASCADE');
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
    await prisma.$executeRawUnsafe(`INSERT INTO "Cnae" (codigo, descricao) VALUES ('0111301', 'Cultivo de arroz')`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Municipio" (codigo, descricao) VALUES ('7107', 'SAO PAULO'), ('6291', 'OSASCO')`,
    );
    for (const base of ['20000001', '20000002', '20000003']) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Empresa" (cnpj_base, razao_social, natureza_juridica, qualificacao_resp, capital_social, porte)
         VALUES ($1, $2, '2062', '49', 15000.5, '01')`,
        base, `EMPRESA ${base} LTDA`,
      );
    }
    await insertEstab('20000001', '7107', '02', { ddd1: '11', tel1: '33334444' });
    await insertEstab('20000002', '7107', '08');
    await insertEstab('20000003', '6291', '02');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  const contagem = (payload: object) =>
    app.inject({ method: 'POST', url: '/integracao/sindical/contagem', headers: AUTH, payload });

  it('contagem situacao ativa + município → só o ativo do 7107, cnpj de 14 dígitos', async () => {
    const res = await contagem({ cnaes: ['0111301'], uf: 'SP', municipios: ['7107'], situacao: 'ativa' });

    expect(res.statusCode).toBe(200);
    expect(res.json().itens).toEqual([
      { cnpj: '20000001000155', municipio: '7107', municipioNome: 'SAO PAULO' },
    ]);
    expect(res.json()).toHaveProperty('baseMes');
  });

  it('contagem situacao todas inclui a baixada', async () => {
    const res = await contagem({ cnaes: ['0111301'], uf: 'SP', municipios: ['7107'], situacao: 'todas' });

    expect(res.json().itens.map((i: { cnpj: string }) => i.cnpj).sort()).toEqual(['20000001000155', '20000002000155']);
  });

  it('contagem com municipios [] → toda a UF', async () => {
    const res = await contagem({ cnaes: ['0111301'], uf: 'SP', municipios: [], situacao: 'ativa' });

    expect(res.statusCode).toBe(200);
    expect(res.json().itens.map((i: { cnpj: string }) => i.cnpj).sort()).toEqual(['20000001000155', '20000003000155']);
  });

  it('cnae-divisoes devolve só divisões com atividades, contando subclasses, ordenado por código', async () => {
    // O beforeEach já traz 0111301 (divisão 01); aqui somam-se 2 subclasses de 47 e 1 de 56.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Cnae" (codigo, descricao) VALUES ('4711301', 'Hipermercados'), ('4711302', 'Supermercados'), ('5611201', 'Restaurantes')`,
    );

    const res = await app.inject({ method: 'GET', url: '/integracao/sindical/cnae-divisoes', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      dados: [
        { codigo: '01', descricao: 'Agricultura, pecuária e serviços relacionados', atividades: 1 },
        { codigo: '47', descricao: 'Comércio varejista', atividades: 2 },
        { codigo: '56', descricao: 'Alimentação', atividades: 1 },
      ],
    });
  });

  it('empresas devolve telefones só dígitos e omite cnpj inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integracao/sindical/empresas',
      headers: AUTH,
      payload: { cnpjs: ['20000001000155', '99999999000199'] },
    });

    expect(res.statusCode).toBe(200);
    const { dados } = res.json();
    expect(dados).toHaveLength(1);
    expect(dados[0]).toMatchObject({
      cnpj: '20000001000155',
      razaoSocial: 'EMPRESA 20000001 LTDA',
      nomeFantasia: null,
      dataInicioAtividade: '20150310',
      capitalSocial: 15000.5,
      cnaeCodigo: '0111301',
      cnaeDescricao: 'Cultivo de arroz',
      situacaoCadastral: '02',
      uf: 'SP',
      municipioNome: 'SAO PAULO',
      telefones: ['1133334444'],
      email: 'contato@teste.com',
    });
  });
});
