import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { connect, ensureLogged } from '../../src/ingest/db';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('ensureLogged (integração)', () => {
  let db: Client;

  async function persistence(table: string): Promise<string> {
    const r = await db.query(
      `SELECT c.relpersistence AS p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = $1`,
      [table],
    );
    return r.rows[0].p;
  }

  beforeAll(async () => {
    db = await connect(url!);
  });

  afterAll(async () => {
    await db.query(`ALTER TABLE "Pais" SET LOGGED`).catch(() => {});
    await db.end();
  });

  it('turns UNLOGGED Receita tables back to LOGGED and logs it', async () => {
    // Simula tabela deixada UNLOGGED pelo pipeline manual antigo.
    await db.query(`ALTER TABLE "Pais" SET UNLOGGED`);
    expect(await persistence('Pais')).toBe('u');
    const logs: string[] = [];

    const fixed = await ensureLogged(db, (m) => logs.push(m));

    expect(fixed).toEqual(['Pais']);
    expect(await persistence('Pais')).toBe('p');
    expect(logs.some((l) => l.includes('Pais') && l.includes('LOGGED'))).toBe(true);
  });

  it('is a no-op when everything is LOGGED', async () => {
    const logs: string[] = [];
    expect(await ensureLogged(db, (m) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });
});
