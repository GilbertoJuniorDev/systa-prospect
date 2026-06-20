import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

const PORT = parseInt(process.env.PORT ?? '3000', 10);

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

    const limiteParsed = Math.min(parseInt(limite ?? '20', 10), 100);

    const empresas = await prisma.$queryRawUnsafe<
      {
        cnpj_base: string;
        razao_social: string;
        natureza_juridica: string;
        qualificacao_resp: string;
        capital_social: number;
        porte: string;
        ente_federativo: string | null;
      }[]
    >(
      `SELECT * FROM "Empresa"
       WHERE razao_social ILIKE $1
       ORDER BY razao_social
       LIMIT $2`,
      `%${nome.trim()}%`,
      limiteParsed,
    );

    return { total: empresas.length, dados: empresas };
  },
);

// ─── GET /empresas/teste ──────────────────────────────────────────────────────

app.get('/empresas/teste', async () => {
  const empresas = await prisma.empresa.findMany({ take: 500 });
  return { total: empresas.length, dados: empresas };
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok' };
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
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
