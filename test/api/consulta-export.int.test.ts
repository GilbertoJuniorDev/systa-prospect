import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const url = process.env.TEST_DATABASE_URL;

// Prisma da API apontando para o banco de testes.
vi.mock('../../src/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  return { prisma: new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL }) };
});

// Autenticação simplificada: o usuário vem do header x-test-user.
vi.mock('../../src/lib/authenticate', () => ({
  authenticate: async (request: any) => {
    request.user = { userId: request.headers['x-test-user'], email: 'teste@example.com' };
  },
}));

// Permite forçar falha na geração do XLSX (depois da cobrança).
const failExport = { on: false };
vi.mock('exceljs', async (importOriginal) => {
  const mod: any = await importOriginal();
  const Real = mod.default?.Workbook ?? mod.Workbook;
  class Workbook extends Real {
    constructor() {
      super();
      const xlsx = (this as any).xlsx;
      const original = xlsx.writeBuffer.bind(xlsx);
      xlsx.writeBuffer = async (...args: unknown[]) => {
        if (failExport.on) throw new Error('falha forçada na exportação');
        return original(...args);
      };
    }
  }
  const def = { ...(mod.default ?? mod), Workbook };
  return { ...mod, default: def, Workbook };
});

import { prisma } from '../../src/lib/prisma';
import { consultaRoutes } from '../../src/routes/consulta';
import { resetBaseStatusCache } from '../../src/lib/base-status';

const BODY = { cnaes: ['0111301'], uf: 'SP', situacao: 'todas', mei: 'todos' } as const;
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!url)('POST /consulta/exportar (integração)', () => {
  let app: FastifyInstance;
  let userId: string;

  async function insertEstabs(n: number, start = 0) {
    for (let i = start; i < start + n; i++) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Estabelecimento" (cnpj_base, cnpj_ordem, cnpj_dv, identificador_matriz_filial, situacao_cadastral, cnae_fiscal_principal, uf)
         VALUES ($1, '0001', '00', '1', '02', '0111301', 'SP')`,
        String(10_000_000 + i),
      );
    }
  }

  async function exportar() {
    return app.inject({
      method: 'POST',
      url: '/consulta/exportar',
      headers: { 'x-test-user': userId },
      payload: BODY,
    });
  }

  async function credits() {
    return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
  }

  async function transactions() {
    return prisma.creditTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async function cache() {
    return prisma.consultaCache.findFirst({ where: { userId } });
  }

  async function cleanup() {
    await prisma.$executeRawUnsafe('TRUNCATE "Estabelecimento", "IngestRun" CASCADE');
    await prisma.creditTransaction.deleteMany({ where: { user: { email: 'export-test@example.com' } } });
    await prisma.user.deleteMany({ where: { email: 'export-test@example.com' } });
  }

  beforeAll(async () => {
    app = Fastify();
    await app.register(consultaRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    await cleanup();
    resetBaseStatusCache();
    failExport.on = false;
    const user = await prisma.user.create({
      data: { email: 'export-test@example.com', passwordHash: 'x', credits: 100 },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  it('first export charges full price and saves cache total/totalAt', async () => {
    await insertEstabs(25);
    const before = Date.now();

    const res = await exportar();

    expect(res.statusCode).toBe(200);
    expect(await credits()).toBe(97); // ceil(25/10)
    const tx = await transactions();
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ amount: -3, type: 'EXPORT' });
    const c = await cache();
    expect(c?.total).toBe(25);
    expect(c?.totalAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('re-export after the base grew charges only the difference (EXPORT_DIFF)', async () => {
    await insertEstabs(25);
    await exportar();
    const firstCache = await cache();
    await insertEstabs(12, 25); // base nova: +12

    const res = await exportar();

    expect(res.statusCode).toBe(200);
    expect(await credits()).toBe(95); // 97 − ceil(12/10)
    const tx = await transactions();
    expect(tx[1]).toMatchObject({
      amount: -2,
      type: 'EXPORT_DIFF',
      description: 'Diferença de exportação após atualização da base: +12 registros',
    });
    const c = await cache();
    expect(c?.total).toBe(37);
    expect(c?.totalAt!.getTime()).toBeGreaterThanOrEqual(firstCache!.totalAt!.getTime());
    // Diferença não renova a validade do cache.
    expect(c?.expiresAt.getTime()).toBe(firstCache!.expiresAt.getTime());
  });

  it('diff charge without enough credits → 402 and nothing changes', async () => {
    await insertEstabs(25);
    await exportar();
    await prisma.user.update({ where: { id: userId }, data: { credits: 1 } });
    await insertEstabs(15, 25); // diferença custa 2

    const res = await exportar();

    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'insufficient_credits', required: 2 });
    expect(await credits()).toBe(1);
    expect((await cache())?.total).toBe(25);
  });

  it('refunds when the export fails after charging', async () => {
    await insertEstabs(25);
    failExport.on = true;

    const res = await exportar();

    expect(res.statusCode).toBe(500);
    expect(await credits()).toBe(100);
    const tx = await transactions();
    expect(tx.map((t) => [t.type, t.amount])).toEqual([
      ['EXPORT', -3],
      ['EXPORT_REFUND', 3],
    ]);
    expect(await cache()).toBeNull();
  });

  it('free re-export updates totalAt only (not total, not expiresAt)', async () => {
    await insertEstabs(25);
    await exportar();
    const old = new Date(Date.now() - 10 * DAY);
    await prisma.consultaCache.updateMany({ where: { userId }, data: { totalAt: old, total: 30 } });
    const before = await cache();

    const res = await exportar();

    expect(res.statusCode).toBe(200);
    expect(await credits()).toBe(97);
    expect(await transactions()).toHaveLength(1);
    const c = await cache();
    expect(c?.total).toBe(30);
    expect(c?.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(c?.totalAt!.getTime()).toBeGreaterThan(old.getTime() + DAY);
  });
});
