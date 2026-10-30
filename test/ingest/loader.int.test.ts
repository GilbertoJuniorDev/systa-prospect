import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import iconv from 'iconv-lite';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { loadCsv } from '../../src/ingest/loader';
import {
  connect,
  truncateReceita,
  dropSecondaryIndexes,
  buildIndexes,
  tryAdvisoryLock,
} from '../../src/ingest/db';
import { CONFIGS, RECEITA_TABLES, SECONDARY_INDEXES } from '../../src/ingest/tables';
import { MARK_INGESTED_SQL, createRun, registerFiles } from '../../src/ingest/state';
import { DiskSpaceError } from '../../src/ingest/errors';

const url = process.env.TEST_DATABASE_URL;
const silent = () => {};

function writeCsv(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, iconv.encode(lines.join('\n') + '\n', 'win1252'));
  return file;
}

const SOCIO_LINES = [
  '"12345678";"2";"JOÃO DA SILVA";"***123456**";"49";"20200101";"";"";"";"00";"3"',
  '"12345678";"2";"MARIA AÇUCENA";"***654321**";"49";"20200102";"";"";"";"00";"4"',
  '"87654321";"2";"JOSÉ";"***111111**";"22";"20200103";"";"";"";"00";"5"',
];

describe.skipIf(!url)('ingest loader (integração)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  let client: Client;
  let dir: string;

  async function cleanTables() {
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${RECEITA_TABLES.map((t) => `"${t}"`).join(', ')}, "IngestRun" CASCADE`,
    );
  }

  async function count(table: string): Promise<number> {
    const r = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return r.rows[0].n;
  }

  async function indexNames(): Promise<string[]> {
    const r = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    return r.rows.map((x) => x.indexname);
  }

  async function recreateAllIndexes() {
    for (const table of Object.keys(SECONDARY_INDEXES)) {
      await buildIndexes(client, table, { minFreeBytes: 0 }, dir, silent);
    }
  }

  async function newRunWithFile(fileName: string): Promise<string> {
    const runId = await createRun(prisma, '2026-10');
    await registerFiles(prisma, runId, [
      { name: fileName, href: `/${fileName}`, size: 10, isDir: false },
    ]);
    return runId;
  }

  beforeAll(async () => {
    client = await connect(url!);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
  });

  beforeEach(async () => {
    await cleanTables();
  });

  afterAll(async () => {
    await cleanTables();
    await client.query(`DELETE FROM "User" WHERE email = 'loader-test@example.com'`);
    await recreateAllIndexes();
    await client.end();
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads Socio rows and marks file in same tx', async () => {
    const runId = await newRunWithFile('Socios0.zip');
    const csv = writeCsv(dir, 'K3241.K03200Y0.D60913.SOCIOCSV', SOCIO_LINES);

    await client.query('BEGIN');
    const { rows, inserted } = await loadCsv(client, csv, CONFIGS['.SOCIOCSV']);
    await client.query(MARK_INGESTED_SQL, [runId, 'Socios0.zip', rows, rows - inserted]);
    await client.query('COMMIT');

    expect(rows).toBe(3);
    expect(inserted).toBe(3);
    expect(await count('Socio')).toBe(3);
    const nome = await client.query(`SELECT nome_socio FROM "Socio" WHERE nome_socio LIKE 'MARIA%'`);
    expect(nome.rows[0].nome_socio).toBe('MARIA AÇUCENA');
    const f = await prisma.ingestFile.findFirstOrThrow({ where: { runId, fileName: 'Socios0.zip' } });
    expect(f.status).toBe('INGESTED');
    expect(f.rows).toBe(3);
    expect(f.discarded).toBe(0);
  });

  it('rollback leaves no rows and file PENDING', async () => {
    const runId = await newRunWithFile('Socios0.zip');
    const csv = writeCsv(dir, 'K3241.K03200Y0.D60913.SOCIOCSV', SOCIO_LINES);

    await client.query('BEGIN');
    const { rows, inserted } = await loadCsv(client, csv, CONFIGS['.SOCIOCSV']);
    await client.query(MARK_INGESTED_SQL, [runId, 'Socios0.zip', rows, rows - inserted]);
    await client.query('ROLLBACK');

    expect(await count('Socio')).toBe(0);
    const f = await prisma.ingestFile.findFirstOrThrow({ where: { runId, fileName: 'Socios0.zip' } });
    expect(f.status).toBe('PENDING');

    await client.query('BEGIN');
    const again = await loadCsv(client, csv, CONFIGS['.SOCIOCSV']);
    await client.query(MARK_INGESTED_SQL, [runId, 'Socios0.zip', again.rows, again.rows - again.inserted]);
    await client.query('COMMIT');
    expect(await count('Socio')).toBe(3);
  });

  it('loads two CSVs of the same table in one transaction', async () => {
    const a = writeCsv(dir, 'A.SOCIOCSV', SOCIO_LINES.slice(0, 2));
    const b = writeCsv(dir, 'B.SOCIOCSV', SOCIO_LINES.slice(2));
    await client.query('BEGIN');
    await loadCsv(client, a, CONFIGS['.SOCIOCSV']);
    await loadCsv(client, b, CONFIGS['.SOCIOCSV']);
    await client.query('COMMIT');
    expect(await count('Socio')).toBe(3);
  });

  it('Empresa duplicate in source counts discarded', async () => {
    const csv = writeCsv(dir, 'K3241.K03200Y0.D60913.EMPRECSV', [
      '"11111111";"EMPRESA UM";"2062";"49";"1000,50";"01";""',
      '"11111111";"EMPRESA UM DUP";"2062";"49";"1000,50";"01";""',
    ]);
    await client.query('BEGIN');
    const { rows, inserted } = await loadCsv(client, csv, CONFIGS['.EMPRECSV']);
    await client.query('COMMIT');
    expect(rows).toBe(2);
    expect(inserted).toBe(1);
    expect(await count('Empresa')).toBe(1);
  });

  it('truncate leaves User untouched', async () => {
    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "updatedAt")
       VALUES ('loader-test-user', 'loader-test@example.com', 'x', now())
       ON CONFLICT DO NOTHING`,
    );
    await client.query(
      `INSERT INTO "Empresa" (cnpj_base, razao_social, natureza_juridica, qualificacao_resp, capital_social, porte)
       VALUES ('99999999', 'X', '2062', '49', 0, '01')`,
    );
    const before = (await client.query(`SELECT count(*)::int AS n FROM "User"`)).rows[0].n;

    await truncateReceita(client);

    expect(await count('Empresa')).toBe(0);
    const after = (await client.query(`SELECT count(*)::int AS n FROM "User"`)).rows[0].n;
    expect(after).toBe(before);
    expect(after).toBeGreaterThanOrEqual(1);
    await client.query(`DELETE FROM "User" WHERE email = 'loader-test@example.com'`);
  });

  it('drop and build indexes', async () => {
    await dropSecondaryIndexes(client);
    const dropped = await indexNames();
    for (const list of Object.values(SECONDARY_INDEXES)) {
      for (const idx of list) expect(dropped).not.toContain(idx.name);
    }

    await buildIndexes(client, 'Socio', { minFreeBytes: 0 }, dir, silent);
    const built = await indexNames();
    expect(built).toContain('idx_socio_cpf');
    expect(built).toContain('idx_socio_cnpj_base');
    expect(built).not.toContain('idx_estab_uf');

    await recreateAllIndexes();
  });

  it('buildIndexes throws DiskSpaceError when minFreeBytes huge', async () => {
    await dropSecondaryIndexes(client);
    await expect(
      buildIndexes(client, 'Socio', { minFreeBytes: Number.MAX_SAFE_INTEGER }, dir, silent),
    ).rejects.toBeInstanceOf(DiskSpaceError);
    expect(await indexNames()).not.toContain('idx_socio_cpf');
    await recreateAllIndexes();
  });

  it('tryAdvisoryLock is exclusive across sessions', async () => {
    const other = await connect(url!);
    try {
      expect(await tryAdvisoryLock(client)).toBe(true);
      expect(await tryAdvisoryLock(other)).toBe(false);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727011)');
      await other.end();
    }
  });
});
