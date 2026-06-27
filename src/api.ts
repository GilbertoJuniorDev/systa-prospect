/// <reference path="./types/fastify.d.ts" />
import 'dotenv/config';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { prisma } from './lib/prisma';
import { authRoutes } from './routes/auth';
import { consultaRoutes } from './routes/consulta';
import { creditsRoutes } from './routes/credits';
import { SITUACAO_MAP, formatFone, formatCNPJ, formatCEP } from './lib/formatters';
import { authenticate } from './lib/authenticate';
import { deductCredits } from './lib/credits';

if (!process.env.DATABASE_URL) {
  console.error('FATAL: variável DATABASE_URL não definida.');
  process.exit(1);
}

const app = Fastify({ logger: true });

const PORT = (() => {
  const p = parseInt(process.env.PORT ?? '3333', 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    console.error('FATAL: PORT inválida. Use um número entre 1 e 65535.');
    process.exit(1);
  }
  return p;
})();

// ─── GET /empresas/cnae/:codigo ──────────────────────────────────────────────

app.get<{
  Params: { codigo: string };
  Querystring: { situacao?: string; mei?: string; limite?: string; pagina?: string };
}>(
  '/empresas/cnae/:codigo',
  async (request, reply) => {
    const codigo = request.params.codigo.replace(/\D/g, '');

    if (!/^\d{7}$/.test(codigo)) {
      return reply.status(400).send({ error: 'O código CNAE deve conter exatamente 7 dígitos numéricos.' });
    }

    const { situacao, mei, limite: limiteStr, pagina: paginaStr } = request.query;

    if (situacao !== undefined && situacao !== 'ativa' && situacao !== 'inativa') {
      return reply.status(400).send({ error: 'Parâmetro "situacao" deve ser "ativa" ou "inativa".' });
    }

    if (mei !== undefined && mei !== 'true' && mei !== 'false') {
      return reply.status(400).send({ error: 'Parâmetro "mei" deve ser "true" ou "false".' });
    }

    const limiteNum = parseInt(limiteStr ?? '50', 10);
    const limite = isNaN(limiteNum) ? 50 : Math.max(1, Math.min(limiteNum, 100));

    const paginaNum = parseInt(paginaStr ?? '1', 10);
    const pagina = isNaN(paginaNum) || paginaNum < 1 ? 1 : paginaNum;
    const offset = (pagina - 1) * limite;

    const situacaoClause =
      situacao === 'ativa'   ? Prisma.sql`AND e.situacao_cadastral = '02'` :
      situacao === 'inativa' ? Prisma.sql`AND e.situacao_cadastral <> '02'` :
      Prisma.empty;

    const meiClause =
      mei === 'true'  ? Prisma.sql`AND s.opcao_mei = 'S'` :
      mei === 'false' ? Prisma.sql`AND (s.opcao_mei IS NULL OR s.opcao_mei <> 'S')` :
      Prisma.empty;

    type CnaeRow = {
      nome_fantasia: string | null;
      razao_social: string;
      situacao_cadastral: string | null;
      municipio_nome: string | null;
      uf: string | null;
      ddd1: string | null;
      telefone1: string | null;
      ddd2: string | null;
      telefone2: string | null;
      correio_eletronico: string | null;
    };

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<CnaeRow[]>`
        SELECT
          e.nome_fantasia,
          emp.razao_social,
          e.situacao_cadastral,
          m.descricao AS municipio_nome,
          e.uf,
          e.ddd1, e.telefone1,
          e.ddd2, e.telefone2,
          e.correio_eletronico
        FROM "Estabelecimento" e
        JOIN "Empresa" emp ON emp.cnpj_base = e.cnpj_base
        LEFT JOIN "Municipio" m ON m.codigo = e.municipio
        LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base
        WHERE e.cnae_fiscal_principal = ${codigo}
          ${situacaoClause}
          ${meiClause}
        ORDER BY emp.razao_social
        LIMIT ${limite} OFFSET ${offset}
      `,
      prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM "Estabelecimento" e
        LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base
        WHERE e.cnae_fiscal_principal = ${codigo}
          ${situacaoClause}
          ${meiClause}
      `,
    ]);

    const total = countRows[0]?.total ?? 0;

    const dados = rows.map((r) => ({
      nome: r.nome_fantasia?.trim() || r.razao_social,
      situacao: SITUACAO_MAP[r.situacao_cadastral ?? ''] ?? r.situacao_cadastral ?? null,
      municipio: r.municipio_nome ?? null,
      uf: r.uf ?? null,
      telefones: [
        formatFone(r.ddd1, r.telefone1),
        formatFone(r.ddd2, r.telefone2),
      ].filter((v): v is string => v !== null),
      emails: r.correio_eletronico
        ? r.correio_eletronico.split(/[,/]/).map((e) => e.trim()).filter(Boolean)
        : [],
    }));

    return { total, pagina, limite, dados };
  },
);

// ─── GET /empresas/:cnpj_base ─────────────────────────────────────────────────

app.get<{ Params: { cnpj_base: string } }>(
  '/empresas/:cnpj_base',
  async (request, reply) => {
    const { cnpj_base } = request.params;

    // Valida que o cnpj_base tenha exatamente 8 dígitos numéricos
    if (!/^\d{8}$/.test(cnpj_base)) {
      return reply.status(400).send({
        error: 'cnpj_base deve conter exatamente 8 dígitos numéricos.',
      });
    }

    const empresa = await prisma.empresa.findUnique({
      where: { cnpj_base },
    });

    if (!empresa) {
      return reply.status(404).send({ error: 'Empresa não encontrada.' });
    }

    return empresa;
  },
);

// ─── GET /empresas/buscar?nome=TERMO ─────────────────────────────────────────

app.get<{ Querystring: { nome?: string; limite?: string } }>(
  '/empresas/buscar',
  async (request, reply) => {
    const { nome, limite } = request.query;

    if (!nome || nome.trim().length < 3) {
      return reply.status(400).send({
        error: 'Parâmetro "nome" é obrigatório e deve ter ao menos 3 caracteres.',
      });
    }

    if (nome.trim().length > 200) {
      return reply.status(400).send({
        error: 'Parâmetro "nome" não pode exceder 200 caracteres.',
      });
    }

    const limiteNum = parseInt(limite ?? '20', 10);
    const limiteParsed = isNaN(limiteNum) ? 20 : Math.min(limiteNum, 100);

    const nomeBusca = `%${nome.trim()}%`;
    const empresas = await prisma.$queryRaw<
      {
        cnpj_base: string;
        razao_social: string;
        natureza_juridica: string;
        qualificacao_resp: string;
        capital_social: number;
        porte: string;
        ente_federativo: string | null;
      }[]
    >`SELECT * FROM "Empresa"
      WHERE razao_social ILIKE ${nomeBusca}
      ORDER BY razao_social
      LIMIT ${limiteParsed}`;

    return { total: empresas.length, dados: empresas };
  },
);

// ─── GET /cnpj/:cnpj ─────────────────────────────────────────────────────────

app.get<{ Params: { cnpj: string } }>(
  '/cnpj/:cnpj',
  { preHandler: [authenticate] },
  async (request, reply) => {
    const cnpj = request.params.cnpj.replace(/\D/g, '');

    if (cnpj.length !== 14) {
      return reply.status(400).send({ error: 'CNPJ deve conter 14 dígitos numéricos.' });
    }

    const cnpj_base  = cnpj.slice(0, 8);
    const cnpj_ordem = cnpj.slice(8, 12);
    const cnpj_dv    = cnpj.slice(12, 14);

    type FullRow = {
      cnpj_base: string;
      cnpj_ordem: string;
      cnpj_dv: string;
      identificador_matriz_filial: string | null;
      nome_fantasia: string | null;
      situacao_cadastral: string | null;
      data_situacao_cadastral: string | null;
      motivo_situacao_cadastral: string | null;
      motivo_descricao: string | null;
      nome_cidade_exterior: string | null;
      pais_codigo: string | null;
      pais_descricao: string | null;
      data_inicio_atividade: string | null;
      cnae_fiscal_principal: string | null;
      cnae_principal_descricao: string | null;
      cnae_fiscal_secundaria: string | null;
      tipo_logradouro: string | null;
      logradouro: string | null;
      numero: string | null;
      complemento: string | null;
      bairro: string | null;
      cep: string | null;
      uf: string | null;
      municipio_codigo: string | null;
      municipio_nome: string | null;
      ddd1: string | null;
      telefone1: string | null;
      ddd2: string | null;
      telefone2: string | null;
      ddd_fax: string | null;
      fax: string | null;
      correio_eletronico: string | null;
      situacao_especial: string | null;
      data_situacao_especial: string | null;
      razao_social: string;
      natureza_juridica: string | null;
      natureza_descricao: string | null;
      qualificacao_resp: string | null;
      qualificacao_resp_descricao: string | null;
      capital_social: number | null;
      porte: string | null;
      ente_federativo: string | null;
      opcao_simples: string | null;
      data_opcao_simples: string | null;
      data_exclusao_simples: string | null;
      opcao_mei: string | null;
      data_opcao_mei: string | null;
      data_exclusao_mei: string | null;
    };

    type SocioRow = {
      identificador_socio: string;
      nome_socio: string | null;
      cnpj_cpf_socio: string | null;
      qualificacao_socio: string | null;
      qualificacao_socio_descricao: string | null;
      data_entrada_sociedade: string | null;
      pais: string | null;
      pais_descricao: string | null;
      representante_legal: string | null;
      nome_representante: string | null;
      qualificacao_representante: string | null;
      qualificacao_representante_descricao: string | null;
      faixa_etaria: string | null;
    };

    const [rows, socios] = await Promise.all([
      prisma.$queryRaw<FullRow[]>`
        SELECT
          e.cnpj_base, e.cnpj_ordem, e.cnpj_dv,
          e.identificador_matriz_filial,
          e.nome_fantasia,
          e.situacao_cadastral,
          e.data_situacao_cadastral,
          e.motivo_situacao_cadastral,
          mot.descricao   AS motivo_descricao,
          e.nome_cidade_exterior,
          e.pais          AS pais_codigo,
          ps.descricao    AS pais_descricao,
          e.data_inicio_atividade,
          e.cnae_fiscal_principal,
          cn.descricao    AS cnae_principal_descricao,
          e.cnae_fiscal_secundaria,
          e.tipo_logradouro, e.logradouro, e.numero, e.complemento,
          e.bairro, e.cep, e.uf,
          e.municipio     AS municipio_codigo,
          m.descricao     AS municipio_nome,
          e.ddd1, e.telefone1, e.ddd2, e.telefone2, e.ddd_fax, e.fax,
          e.correio_eletronico,
          e.situacao_especial, e.data_situacao_especial,
          emp.razao_social,
          emp.natureza_juridica,
          nat.descricao   AS natureza_descricao,
          emp.qualificacao_resp,
          qr.descricao    AS qualificacao_resp_descricao,
          emp.capital_social, emp.porte, emp.ente_federativo,
          s.opcao_simples, s.data_opcao_simples, s.data_exclusao_simples,
          s.opcao_mei,    s.data_opcao_mei,    s.data_exclusao_mei
        FROM "Estabelecimento" e
        JOIN  "Empresa"      emp ON emp.cnpj_base = e.cnpj_base
        LEFT JOIN "Municipio"    m   ON m.codigo   = e.municipio
        LEFT JOIN "Motivo"       mot ON mot.codigo = e.motivo_situacao_cadastral
        LEFT JOIN "Pais"         ps  ON ps.codigo  = e.pais
        LEFT JOIN "Cnae"         cn  ON cn.codigo  = e.cnae_fiscal_principal
        LEFT JOIN "Natureza"     nat ON nat.codigo = emp.natureza_juridica
        LEFT JOIN "Qualificacao" qr  ON qr.codigo  = emp.qualificacao_resp
        LEFT JOIN "Simples"      s   ON s.cnpj_base = e.cnpj_base
        WHERE e.cnpj_base  = ${cnpj_base}
          AND e.cnpj_ordem = ${cnpj_ordem}
          AND e.cnpj_dv    = ${cnpj_dv}
      `,
      prisma.$queryRaw<SocioRow[]>`
        SELECT
          sc.identificador_socio, sc.nome_socio, sc.cnpj_cpf_socio,
          sc.qualificacao_socio,
          qs.descricao  AS qualificacao_socio_descricao,
          sc.data_entrada_sociedade,
          sc.pais,
          ps.descricao  AS pais_descricao,
          sc.representante_legal, sc.nome_representante,
          sc.qualificacao_representante,
          qr.descricao  AS qualificacao_representante_descricao,
          sc.faixa_etaria
        FROM "Socio" sc
        LEFT JOIN "Qualificacao" qs ON qs.codigo = sc.qualificacao_socio
        LEFT JOIN "Pais"         ps ON ps.codigo = sc.pais
        LEFT JOIN "Qualificacao" qr ON qr.codigo = sc.qualificacao_representante
        WHERE sc.cnpj_base = ${cnpj_base}
        ORDER BY sc.nome_socio
      `,
    ]);

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'CNPJ não encontrado.' });
    }

    const credited = await deductCredits(
      request.user.userId,
      1,
      'CNPJ_QUERY',
      'Consulta CNPJ ' + cnpj,
      reply,
    );
    if (!credited) return;

    const r = rows[0];

    const codigosSecundarios: string[] = r.cnae_fiscal_secundaria
      ? r.cnae_fiscal_secundaria.split(',').map((c: string) => c.trim()).filter((c: string) => /^\d{7}$/.test(c))
      : [];

    const cnaesSecundarios = codigosSecundarios.length > 0
      ? await prisma.$queryRaw<{ codigo: string; descricao: string }[]>`
          SELECT codigo, descricao FROM "Cnae"
          WHERE codigo = ANY(${codigosSecundarios})
          ORDER BY codigo
        `
      : [];

    return {
      cnpj: formatCNPJ(r.cnpj_base, r.cnpj_ordem, r.cnpj_dv),
      cnpj_base: r.cnpj_base,
      identificacao: {
        razao_social: r.razao_social.trim(),
        nome_fantasia: r.nome_fantasia?.trim() ?? null,
        tipo: r.identificador_matriz_filial === '1' ? 'Matriz' : 'Filial',
      },
      situacao_cadastral: {
        codigo: r.situacao_cadastral ?? null,
        descricao: SITUACAO_MAP[r.situacao_cadastral ?? ''] ?? r.situacao_cadastral ?? null,
        data: r.data_situacao_cadastral ?? null,
        motivo_codigo: r.motivo_situacao_cadastral ?? null,
        motivo_descricao: r.motivo_descricao ?? null,
      },
      empresa: {
        natureza_juridica: r.natureza_juridica ?? null,
        natureza_descricao: r.natureza_descricao ?? null,
        porte: r.porte ?? null,
        capital_social: r.capital_social ?? null,
        qualificacao_resp: r.qualificacao_resp ?? null,
        qualificacao_resp_descricao: r.qualificacao_resp_descricao ?? null,
        ente_federativo: r.ente_federativo ?? null,
      },
      atividade: {
        data_inicio_atividade: r.data_inicio_atividade ?? null,
        situacao_especial: r.situacao_especial ?? null,
        data_situacao_especial: r.data_situacao_especial ?? null,
        pais_codigo: r.pais_codigo ?? null,
        pais_descricao: r.pais_descricao ?? null,
        nome_cidade_exterior: r.nome_cidade_exterior ?? null,
      },
      cnae: {
        principal: r.cnae_fiscal_principal
          ? { codigo: r.cnae_fiscal_principal, descricao: r.cnae_principal_descricao ?? null }
          : null,
        secundarios: cnaesSecundarios,
      },
      endereco: {
        tipo_logradouro: r.tipo_logradouro ?? null,
        logradouro: r.logradouro ?? null,
        numero: r.numero ?? null,
        complemento: r.complemento ?? null,
        bairro: r.bairro ?? null,
        cep: formatCEP(r.cep),
        municipio_codigo: r.municipio_codigo ?? null,
        municipio: r.municipio_nome ?? null,
        uf: r.uf ?? null,
      },
      contato: {
        telefone1: formatFone(r.ddd1, r.telefone1),
        telefone2: formatFone(r.ddd2, r.telefone2),
        fax: formatFone(r.ddd_fax, r.fax),
        emails: r.correio_eletronico
          ? r.correio_eletronico.split(/[,/]/).map((e: string) => e.trim()).filter(Boolean)
          : [],
      },
      simples: {
        opcao_simples: r.opcao_simples ?? null,
        data_opcao_simples: r.data_opcao_simples ?? null,
        data_exclusao_simples: r.data_exclusao_simples ?? null,
        opcao_mei: r.opcao_mei ?? null,
        data_opcao_mei: r.data_opcao_mei ?? null,
        data_exclusao_mei: r.data_exclusao_mei ?? null,
      },
      socios: socios.map((s: SocioRow) => ({
        identificador_socio: s.identificador_socio,
        nome_socio: s.nome_socio ?? null,
        cnpj_cpf_socio: s.cnpj_cpf_socio ?? null,
        qualificacao_socio: s.qualificacao_socio_descricao ?? null,
        data_entrada_sociedade: s.data_entrada_sociedade ?? null,
        pais: s.pais_descricao ?? null,
        nome_representante: s.nome_representante ?? null,
        qualificacao_representante: s.qualificacao_representante_descricao ?? null,
        faixa_etaria: s.faixa_etaria ?? null,
      })),
    };
  },
);

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok' };
});

// ─── Handler global de erros ──────────────────────────────────────────────────

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const pgCode = (error.meta as Record<string, unknown> | undefined)?.code;
    if (error.code === 'P2010' && pgCode === '53100') {
      app.log.error({ err: error }, 'PostgreSQL shared memory exhausted (53100)');
      return reply.status(503).send({
        error:
          'O servidor de banco de dados está temporariamente sem recursos. ' +
          'Tente novamente em alguns instantes ou refine os filtros da consulta.',
      });
    }
  }
  app.log.error(error);
  reply.status(error.statusCode ?? 500).send({ error: 'Erro interno do servidor.' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await app.register(helmet);
    await app.register(cors, {
      origin: process.env.APP_FRONTEND_URL ?? 'http://localhost:3001',
    });
    await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
    await app.register(authRoutes, { prefix: '/auth' });
    await app.register(consultaRoutes);
    await app.register(creditsRoutes);
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start().finally(async () => {
  // Não desconecta aqui — a API precisa manter a conexão ativa
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await app.close();
  process.exit(0);
});
