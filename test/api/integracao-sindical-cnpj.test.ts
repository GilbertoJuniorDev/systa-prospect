import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Sem banco: o prisma é substituído por respostas na ordem em que o serviço consulta
// (estabelecimento, sócios e, se houver, descrições dos CNAEs secundários).
const queryRaw = vi.fn();
vi.mock('../../src/lib/prisma', () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

import { integracaoSindicalRoutes } from '../../src/routes/integracao-sindical';

const KEY = 'chave-sindical-teste';
const AUTH = { 'x-sindical-api-key': KEY };
const URL = '/integracao/sindical/cnpj/12345678000199';

const ESTABELECIMENTO = {
  cnpj_base: '12345678',
  cnpj_ordem: '0001',
  cnpj_dv: '99',
  identificador_matriz_filial: '1',
  nome_fantasia: 'MERCADO BOM',
  situacao_cadastral: '02',
  data_situacao_cadastral: '20150310',
  motivo_situacao_cadastral: null,
  motivo_descricao: null,
  razao_social: 'MERCADO BOM LTDA ',
  cnae_fiscal_principal: '4711302',
  cnae_principal_descricao: 'Comércio varejista de mercadorias em geral',
  cnae_fiscal_secundaria: '4712100,4721102',
  tipo_logradouro: 'RUA',
  logradouro: 'DAS FLORES',
  numero: '120',
  complemento: 'SALA 2',
  bairro: 'CENTRO',
  cep: '45000100',
  uf: 'BA',
  municipio_codigo: '3503',
  municipio_nome: 'VITORIA DA CONQUISTA',
};

const SOCIOS = [
  {
    identificador_socio: '2',
    nome_socio: 'MARIA DA SILVA',
    cnpj_cpf_socio: '***456789**',
    qualificacao_socio_descricao: 'Sócio-Administrador',
  },
  {
    identificador_socio: '1',
    nome_socio: 'HOLDING SA',
    cnpj_cpf_socio: '11222333000144',
    qualificacao_socio_descricao: 'Sócio',
  },
];

const SECUNDARIOS = [
  { codigo: '4712100', descricao: 'Comércio varejista de doces' },
  { codigo: '4721102', descricao: 'Padaria' },
];

describe('GET /integracao/sindical/cnpj/:cnpj', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SINDICAL_API_KEY = KEY;
    app = Fastify();
    await app.register(integracaoSindicalRoutes);
    await app.ready();
  });

  beforeEach(() => queryRaw.mockReset());

  afterAll(async () => {
    await app.close();
  });

  const get = (url = URL, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'GET', url, headers });

  it('sem x-sindical-api-key → 401, sem consultar o banco', async () => {
    const res = await get(URL, {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('chave errada → 401', async () => {
    const res = await get(URL, { 'x-sindical-api-key': 'errada' });
    expect(res.statusCode).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('CNPJ sem 14 dígitos → 400', async () => {
    const res = await get('/integracao/sindical/cnpj/123');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'CNPJ deve conter 14 dígitos numéricos.' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('CNPJ fora da base → 404', async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'CNPJ não encontrado.' });
  });

  it('devolve situação, CNAEs, município/UF e QSA com o CPF como a Receita publica', async () => {
    queryRaw
      .mockResolvedValueOnce([ESTABELECIMENTO])
      .mockResolvedValueOnce(SOCIOS)
      .mockResolvedValueOnce(SECUNDARIOS);

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cnpj: '12345678000199',
      razaoSocial: 'MERCADO BOM LTDA',
      situacaoCadastral: { codigo: '02', descricao: 'Ativa' },
      cnaePrincipal: { codigo: '4711302', descricao: 'Comércio varejista de mercadorias em geral' },
      cnaesSecundarios: SECUNDARIOS,
      municipio: { codigo: '3503', nome: 'VITORIA DA CONQUISTA' },
      uf: 'BA',
      endereco: {
        tipoLogradouro: 'RUA',
        logradouro: 'DAS FLORES',
        numero: '120',
        complemento: 'SALA 2',
        bairro: 'CENTRO',
        cep: '45000-100',
      },
      socios: [
        {
          tipo: 'pessoa_fisica',
          nome: 'MARIA DA SILVA',
          documento: '***456789**',
          qualificacao: 'Sócio-Administrador',
        },
        {
          tipo: 'pessoa_juridica',
          nome: 'HOLDING SA',
          documento: '11222333000144',
          qualificacao: 'Sócio',
        },
      ],
    });
  });

  it('sem CNAE principal nem secundários nem sócios → null e listas vazias', async () => {
    queryRaw.mockResolvedValueOnce([
      { ...ESTABELECIMENTO, cnae_fiscal_principal: null, cnae_fiscal_secundaria: null },
    ]).mockResolvedValueOnce([]);

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cnaePrincipal: null, cnaesSecundarios: [], socios: [] });
  });
});
