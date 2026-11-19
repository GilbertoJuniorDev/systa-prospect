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

describe.skipIf(!url)('POST /integracao/sindical/exportar (integração)', () => {
  let app: FastifyInstance;

  async function insertEmpresa(base: string, razao: string) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Empresa" (cnpj_base, razao_social, natureza_juridica, qualificacao_resp, capital_social, porte)
       VALUES ($1, $2, '2062', '49', 1000, '01')`,
      base,
      razao,
    );
  }

  async function insertEstab(base: string, matrizFilial: string, extra: { ddd1?: string; tel1?: string } = {}) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Estabelecimento"
         (cnpj_base, cnpj_ordem, cnpj_dv, identificador_matriz_filial, situacao_cadastral,
          cnae_fiscal_principal, uf, municipio, data_inicio_atividade, nome_fantasia, tipo_logradouro,
          logradouro, numero, bairro, cep, ddd1, telefone1, correio_eletronico)
       VALUES ($1, '0001', '55', $2, '02', '0111301', 'SP', '7107', '20150310', '  FANTASIA  ', 'RUA',
               'DAS FLORES', '10', 'CENTRO', '01001000', $3, $4, 'Contato@Teste.com')`,
      base,
      matrizFilial,
      extra.ddd1 ?? null,
      extra.tel1 ?? null,
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
    await prisma.$executeRawUnsafe(`INSERT INTO "Cnae" (codigo, descricao) VALUES ('0111301', 'Cultivo de arroz')`);
    await prisma.$executeRawUnsafe(`INSERT INTO "Municipio" (codigo, descricao) VALUES ('7107', 'SAO PAULO')`);
    // Inseridas fora da ordem alfabética para provar o ORDER BY razao_social.
    await insertEmpresa('40000002', 'BETA LTDA');
    await insertEmpresa('40000001', '  ALFA LTDA ');
    await insertEstab('40000002', '2');
    await insertEstab('40000001', '1', { ddd1: '11', tel1: '33334444' });
    await prisma.$executeRawUnsafe(`INSERT INTO "Simples" (cnpj_base, opcao_mei) VALUES ('40000001', 'S')`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  const exportar = (payload: object) =>
    app.inject({ method: 'POST', url: '/integracao/sindical/exportar', headers: AUTH, payload });

  const base = { cnaes: ['0111301'], uf: 'SP', municipios: ['7107'], situacao: 'ativa' };

  it('devolve matriz e filial ordenadas por razão social, com MEI, situação e dados cadastrais', async () => {
    const res = await exportar(base);

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toHaveProperty('baseMes');
    expect(json.filtros).toEqual({ divisoes: [], mei: 'todos' });
    expect(json.itens).toHaveLength(2);
    expect(json.itens[0]).toEqual({
      cnpj: '40000001000155',
      razaoSocial: 'ALFA LTDA',
      nomeFantasia: 'FANTASIA',
      matrizFilial: 'Matriz',
      situacao: 'Ativa',
      dataInicioAtividade: '20150310',
      cnaeCodigo: '0111301',
      cnaeDescricao: 'Cultivo de arroz',
      mei: true,
      uf: 'SP',
      municipio: '7107',
      municipioNome: 'SAO PAULO',
      tipoLogradouro: 'RUA',
      logradouro: 'DAS FLORES',
      numero: '10',
      complemento: null,
      bairro: 'CENTRO',
      cep: '01001000',
      telefones: ['1133334444'],
      email: 'contato@teste.com',
    });
    expect(json.itens[1]).toMatchObject({
      cnpj: '40000002000155',
      matrizFilial: 'Filial',
      mei: false,
      telefones: [],
    });
  });

  it('razão social igual desempata por CNPJ, independente da ordem de inserção', async () => {
    await insertEmpresa('40000004', 'GAMA LTDA');
    await insertEmpresa('40000003', 'GAMA LTDA');
    await insertEstab('40000004', '1');
    await insertEstab('40000003', '2');

    const res = await exportar(base);

    expect(res.json().itens.map((i: { cnpj: string }) => i.cnpj)).toEqual([
      '40000001000155',
      '40000002000155',
      '40000003000155',
      '40000004000155',
    ]);
  });

  it('sem razão social (sem Empresa ou em branco) usa o nome fantasia', async () => {
    await insertEmpresa('40000006', '   ');
    await insertEstab('40000005', '1');
    await insertEstab('40000006', '1');

    const res = await exportar(base);

    const porCnpj = new Map(
      res.json().itens.map((i: { cnpj: string; razaoSocial: string }) => [i.cnpj, i.razaoSocial]),
    );
    expect(porCnpj.get('40000005000155')).toBe('FANTASIA');
    expect(porCnpj.get('40000006000155')).toBe('FANTASIA');
  });

  it('mei "nao" devolve só o filial; "sim" só o matriz', async () => {
    const nao = await exportar({ ...base, mei: 'nao' });
    const sim = await exportar({ ...base, mei: 'sim' });

    expect(nao.json().itens.map((i: { matrizFilial: string }) => i.matrizFilial)).toEqual(['Filial']);
    expect(sim.json().itens.map((i: { matrizFilial: string }) => i.matrizFilial)).toEqual(['Matriz']);
    expect(nao.json().filtros).toEqual({ divisoes: [], mei: 'nao' });
  });

  it('divisão sem subclasses na base → itens vazios, sem erro', async () => {
    const res = await exportar({ ...base, cnaes: [], divisoes: ['03'] });

    expect(res.statusCode).toBe(200);
    expect(res.json().itens).toEqual([]);
    expect(res.json().filtros).toEqual({ divisoes: ['03'], mei: 'todos' });
  });
});
