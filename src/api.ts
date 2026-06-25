import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { prisma } from './lib/prisma';
import { authRoutes } from './routes/auth';

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

const SITUACAO_MAP: Record<string, string> = {
  '01': 'Nula',
  '02': 'Ativa',
  '03': 'Suspensa',
  '04': 'Inapta',
  '08': 'Baixada',
};

function formatFone(ddd: string | null, numero: string | null): string | null {
  if (!ddd?.trim() || !numero?.trim()) return null;
  return `(${ddd.trim()}) ${numero.trim()}`;
}

app.get<{ Params: { cnpj: string } }>(
  '/cnpj/:cnpj',
  async (request, reply) => {
    const cnpj = request.params.cnpj.replace(/\D/g, '');

    if (cnpj.length !== 14) {
      return reply.status(400).send({ error: 'CNPJ deve conter 14 dígitos numéricos.' });
    }

    const cnpj_base = cnpj.slice(0, 8);
    const cnpj_ordem = cnpj.slice(8, 12);
    const cnpj_dv = cnpj.slice(12, 14);

    type Row = {
      razao_social: string;
      nome_fantasia: string | null;
      situacao_cadastral: string | null;
      tipo_logradouro: string | null;
      logradouro: string | null;
      numero: string | null;
      complemento: string | null;
      bairro: string | null;
      cep: string | null;
      uf: string | null;
      municipio_nome: string | null;
      ddd1: string | null;
      telefone1: string | null;
      ddd2: string | null;
      telefone2: string | null;
      ddd_fax: string | null;
      fax: string | null;
      correio_eletronico: string | null;
    };

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        emp.razao_social,
        e.nome_fantasia,
        e.situacao_cadastral,
        e.tipo_logradouro,
        e.logradouro,
        e.numero,
        e.complemento,
        e.bairro,
        e.cep,
        e.uf,
        m.descricao AS municipio_nome,
        e.ddd1, e.telefone1,
        e.ddd2, e.telefone2,
        e.ddd_fax, e.fax,
        e.correio_eletronico
      FROM "Estabelecimento" e
      JOIN "Empresa" emp ON emp.cnpj_base = e.cnpj_base
      LEFT JOIN "Municipio" m ON m.codigo = e.municipio
      WHERE e.cnpj_base = ${cnpj_base}
        AND e.cnpj_ordem = ${cnpj_ordem}
        AND e.cnpj_dv = ${cnpj_dv}
    `;

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'CNPJ não encontrado.' });
    }

    const r = rows[0];

    const logradouroCompleto = [r.tipo_logradouro, r.logradouro]
      .filter(Boolean)
      .join(' ') || null;

    const telefones = [
      formatFone(r.ddd1, r.telefone1),
      formatFone(r.ddd2, r.telefone2),
      formatFone(r.ddd_fax, r.fax),
    ].filter((v): v is string => v !== null);

    const emails = r.correio_eletronico
      ? r.correio_eletronico.split(/[,/]/).map((e) => e.trim()).filter(Boolean)
      : [];

    return {
      cnpj,
      razao_social: r.razao_social,
      nome_fantasia: r.nome_fantasia ?? null,
      situacao: SITUACAO_MAP[r.situacao_cadastral ?? ''] ?? r.situacao_cadastral ?? null,
      endereco: {
        logradouro: logradouroCompleto,
        numero: r.numero ?? null,
        complemento: r.complemento ?? null,
        bairro: r.bairro ?? null,
        municipio: r.municipio_nome ?? null,
        uf: r.uf ?? null,
        cep: r.cep ?? null,
      },
      telefones,
      emails,
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
  app.log.error(error);
  reply.status(error.statusCode ?? 500).send({ error: 'Erro interno do servidor.' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await app.register(helmet);
    await app.register(cors, { origin: false });
    await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
    await app.register(authRoutes, { prefix: '/auth' });
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
