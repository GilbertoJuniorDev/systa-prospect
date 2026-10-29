import { Client } from 'pg';
import type { IngestConfig } from './config';
import { assertSpace, freeBytes, requiredForIndex } from './disk';
import { RECEITA_TABLES, SECONDARY_INDEXES } from './tables';

// ─── Conexão com retry (trata 57P03 WAL recovery, ECONNREFUSED) ──────────────

const RETRYABLE = new Set(['57P03', 'ECONNREFUSED', '08006', '08001', '08004']);

export async function connect(databaseUrl: string, maxAttempts = 10): Promise<Client> {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (err: any) {
      await client.end().catch(() => {});
      const code = err?.code as string | undefined;
      if (!RETRYABLE.has(code ?? '') && !err?.message?.includes('ECONNREFUSED')) {
        throw err;
      }
      if (attempt === maxAttempts) throw err;
      console.log(`  ⏳ Banco indisponível (${code}), aguardando ${delay / 1000}s... (tentativa ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  throw new Error('unreachable');
}

// ─── Operações de carga ──────────────────────────────────────────────────────

/** Esvazia apenas as tabelas da Receita, numa única instrução. */
export async function truncateReceita(client: Client): Promise<void> {
  const tabelas = RECEITA_TABLES.map((t) => `"${t}"`).join(', ');
  await client.query(`TRUNCATE ${tabelas} RESTART IDENTITY`);
}

export async function dropSecondaryIndexes(client: Client): Promise<void> {
  for (const indexes of Object.values(SECONDARY_INDEXES)) {
    for (const idx of indexes) {
      await client.query(`DROP INDEX IF EXISTS "${idx.name}"`);
    }
  }
}

/**
 * Prepara a base para a carga numa única transação: TRUNCATE, DROP dos índices
 * secundários e `prepared=true` no run. Ou tudo acontece, ou nada — nunca fica
 * base truncada com run "não preparado" (que poderia ser abandonado).
 */
export async function prepareBase(client: Client, runId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await truncateReceita(client);
    await dropSecondaryIndexes(client);
    const r = await client.query(`UPDATE "IngestRun" SET prepared = true WHERE id = $1`, [runId]);
    if (r.rowCount !== 1) throw new Error(`IngestRun ${runId} não encontrado ao preparar a base`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Cria os índices ausentes da tabela (checando disco antes de cada um) e roda ANALYZE. */
export async function buildIndexes(
  client: Client,
  table: string,
  cfg: Pick<IngestConfig, 'minFreeBytes'>,
  tempDir: string,
  log: (m: string) => void,
): Promise<void> {
  for (const idx of SECONDARY_INDEXES[table] ?? []) {
    const existing = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
      [idx.name],
    );
    if ((existing.rowCount ?? 0) > 0) continue;

    const size = await client.query(`SELECT pg_relation_size('"${table}"') AS bytes`);
    const tableBytes = Number(size.rows[0].bytes);
    assertSpace(await freeBytes(tempDir), requiredForIndex(tableBytes, cfg), `índice ${idx.name}`);

    log(`Criando índice ${idx.name}...`);
    await client.query(idx.sql);
  }
  await client.query(`ANALYZE "${table}"`);
}

/**
 * Verificação única no start do agendador: tabela da Receita deixada UNLOGGED
 * (pipeline manual antigo) seria esvaziada num crash do Postgres. Volta para LOGGED.
 */
export async function ensureLogged(client: Client, log: (m: string) => void): Promise<string[]> {
  const r = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relpersistence = 'u'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname`,
    [RECEITA_TABLES],
  );
  const fixed: string[] = [];
  for (const { relname } of r.rows) {
    log(`Tabela ${relname} está UNLOGGED; convertendo para LOGGED...`);
    await client.query(`ALTER TABLE "${relname}" SET LOGGED`);
    log(`Tabela ${relname} convertida para LOGGED`);
    fixed.push(relname);
  }
  return fixed;
}

export async function tryAdvisoryLock(client: Client): Promise<boolean> {
  const r = await client.query('SELECT pg_try_advisory_lock(727011) AS locked');
  return r.rows[0].locked === true;
}
