import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Captura o SQL da rota: o que importa aqui é o teto de linhas da consulta.
const consultas: string[] = [];
const tx = {
  $executeRaw: vi.fn(async () => 0),
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
    consultas.push(strings.join('?'));
    return [];
  }),
};
vi.mock('../../src/lib/prisma', () => ({
  prisma: { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
}));
vi.mock('../../src/lib/base-status', () => ({
  getBaseStatus: vi.fn(),
  cacheNotice: vi.fn(),
  formatBaseDate: vi.fn(),
}));

import { consultaRoutes } from '../../src/routes/consulta';

describe('GET /municipios', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(consultaRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('comporta a maior UF (MG tem 853 municípios): LIMIT >= 1000', async () => {
    const res = await app.inject({ method: 'GET', url: '/municipios?uf=MG' });
    expect(res.statusCode).toBe(200);
    // O último LIMIT é o da consulta externa (há um LIMIT 1 no EXISTS).
    const limites = [...(consultas[0] ?? '').matchAll(/LIMIT\s+(\d+)/gi)];
    expect(Number(limites.at(-1)?.[1])).toBeGreaterThanOrEqual(1000);
  });
});
