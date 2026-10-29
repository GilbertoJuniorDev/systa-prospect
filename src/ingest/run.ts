import fs from 'fs';
import path from 'path';
import type { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import unzipper from 'unzipper';
import type { IngestConfig } from './config';
import { buildIndexes, dropSecondaryIndexes, truncateReceita } from './db';
import { assertSpace, freeBytes, requiredForZip } from './disk';
import type { downloadFile } from './downloader';
import { classifyError, PermanentError } from './errors';
import type { loadCsv } from './loader';
import type { Notifier } from './notify';
import {
  MARK_INGESTED_SQL,
  markFailed,
  markPrepared,
  markRunning,
  markSuccess,
  pendingFiles,
  registerFiles,
  setPhase,
} from './state';
import { configForCsv, TABLE_ORDER, type TabelaConfig } from './tables';
import { davAuthHeader, davMonthUrl, type listMonthFiles } from './webdav';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface RunDeps {
  cfg: IngestConfig;
  prisma: PrismaClient;
  db: Client;
  listMonthFiles: typeof listMonthFiles;
  downloadFile: typeof downloadFile;
  extractZip: (zip: string, destDir: string) => Promise<string[]>;
  loadCsv: typeof loadCsv;
  freeBytes: typeof freeBytes;
  notifier: Notifier;
  log: (m: string) => void;
  now?: () => Date;
}

type PendingFile = { fileName: string; size: number; tableName: string };

const MAX_ZIP_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB

// ─── Descompactação ──────────────────────────────────────────────────────────

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Extrai o ZIP em `destDir` e devolve os caminhos absolutos dos arquivos extraídos. */
export async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  const stat = fs.statSync(zipPath);
  if (stat.size > MAX_ZIP_SIZE) {
    throw new PermanentError(`Arquivo ZIP excede o limite de 20 GB: ${path.basename(zipPath)}`);
  }

  const dest = path.resolve(destDir);
  fs.mkdirSync(dest, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(zipPath);
    input.on('error', reject);
    input
      .pipe(unzipper.Extract({ path: dest }))
      .on('close', () => resolve())
      .on('error', reject);
  });

  return listFilesRecursive(dest);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** Esvazia o diretório (criando-o se não existir), mantendo os nomes em `keep`. */
function cleanDir(dir: string, keep: Set<string> = new Set()): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && keep.has(entry.name)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

// ─── Um ZIP ──────────────────────────────────────────────────────────────────

async function ingestZip(
  runId: string,
  month: string,
  file: PendingFile,
  deps: RunDeps,
): Promise<void> {
  const { cfg, db, log } = deps;
  const zipPath = path.join(cfg.tempDir, file.fileName);
  const extractDir = path.join(cfg.tempDir, runId);

  // Disco: um ZIP já completo no disco não precisa de espaço para download.
  if (fileSize(zipPath) !== file.size) {
    assertSpace(await deps.freeBytes(cfg.tempDir), requiredForZip(file.size, cfg), file.fileName);
  }

  await deps.downloadFile({
    url: davMonthUrl(month) + encodeURIComponent(file.fileName),
    dest: zipPath,
    size: file.size,
    headers: { Authorization: davAuthHeader(cfg) },
    log,
  });

  // Sobras de uma extração interrompida não podem ser carregadas de novo.
  fs.rmSync(extractDir, { recursive: true, force: true });
  const csvs = await deps.extractZip(zipPath, extractDir);
  if (csvs.length === 0) {
    throw new PermanentError(`nenhum arquivo encontrado em ${file.fileName}`);
  }

  const configs: { csv: string; config: TabelaConfig }[] = csvs.map((csv) => {
    const config = configForCsv(path.basename(csv));
    if (!config || config.tabela !== file.tableName) {
      throw new PermanentError(`arquivo inesperado ${path.basename(csv)} em ${file.fileName}`);
    }
    return { csv, config };
  });

  // Carga e marcação na mesma transação: crash no meio não duplica linhas.
  await db.query('BEGIN');
  try {
    let rows = 0;
    let inserted = 0;
    for (const { csv, config } of configs) {
      log(`Carregando ${path.basename(csv)} em ${config.tabela}...`);
      const r = await deps.loadCsv(db, csv, config);
      rows += r.rows;
      inserted += r.inserted;
    }
    const marked = await db.query(MARK_INGESTED_SQL, [runId, file.fileName, rows, rows - inserted]);
    if (marked.rowCount !== 1) {
      throw new Error(`IngestFile ${file.fileName} não encontrado para o run ${runId}`);
    }
    await db.query('COMMIT');
    log(`${file.fileName}: ${inserted} registros inseridos, ${rows - inserted} descartados`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }

  // Só depois do COMMIT: crash antes disso reaproveita o ZIP já baixado.
  try {
    for (const csv of csvs) fs.rmSync(csv, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  } catch (err) {
    log(`Falha ao apagar temporários de ${file.fileName}: ${errorMessage(err)}`);
  }

  try {
    log(`Espaço livre: ${gb(await deps.freeBytes(cfg.tempDir))} GB`);
  } catch (err) {
    log(`Não foi possível medir o espaço livre: ${errorMessage(err)}`);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function rowsByTable(prisma: PrismaClient, runId: string): Promise<Record<string, number>> {
  const groups = await prisma.ingestFile.groupBy({
    by: ['tableName'],
    where: { runId, status: 'INGESTED' },
    _sum: { rows: true },
  });
  const result: Record<string, number> = {};
  for (const table of TABLE_ORDER) {
    const g = groups.find((x) => x.tableName === table);
    if (g) result[table] = g._sum.rows ?? 0;
  }
  return result;
}

/**
 * Executa (ou retoma) um run de ingestão. Nunca rejeita: qualquer erro é
 * classificado, gravado com markFailed e notificado (respeitando o limite de e-mails).
 */
export async function executeRun(runId: string, deps: RunDeps): Promise<void> {
  const { cfg, prisma, db, notifier, log } = deps;
  const now = deps.now ?? (() => new Date());
  let month = '';
  let phase: string | null = null;
  let succeeded = false;

  try {
    const run = await prisma.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    month = run.month;
    const recovered = run.errorKind !== null;

    await markRunning(prisma, runId);
    log(`Run ${runId} (mês ${month}) ${run.prepared ? 'retomado' : 'iniciado'}`);

    if (!run.prepared) {
      cleanDir(cfg.tempDir);
      await truncateReceita(db);
      await dropSecondaryIndexes(db);
      await markPrepared(prisma, runId);
      await notifier.started(month);
    }

    await registerFiles(prisma, runId, await deps.listMonthFiles(cfg, month));

    const known = await prisma.ingestFile.count({ where: { runId, tableName: { not: null } } });
    if (known === 0) {
      throw new PermanentError(`nenhum arquivo da Receita encontrado no mês ${month}`);
    }

    const pending = await pendingFiles(prisma, runId);
    cleanDir(cfg.tempDir, new Set(pending.map((f) => f.fileName)));

    for (const table of TABLE_ORDER) {
      for (const file of pending.filter((f) => f.tableName === table)) {
        phase = `${table}: ${file.fileName}`;
        await setPhase(prisma, runId, phase);
        await ingestZip(runId, month, file, deps);
      }
      phase = `${table}: índices`;
      await buildIndexes(db, table, cfg, cfg.tempDir, log);
    }

    const totals = await rowsByTable(prisma, runId);
    await markSuccess(prisma, runId);
    succeeded = true;
    log(`Run ${runId} (mês ${month}) concluído com sucesso`);

    await notifier.succeeded({
      month,
      durationMs: now().getTime() - run.startedAt.getTime(),
      rowsByTable: totals,
      recovered,
    });
    cleanDir(cfg.tempDir);
  } catch (err) {
    if (succeeded) {
      log(`Run ${runId} concluído, mas a finalização falhou: ${errorMessage(err)}`);
      return;
    }
    try {
      const kind = classifyError(err);
      const message = errorMessage(err);
      log(`Run ${runId} falhou (${kind}): ${message}`);
      const { shouldEmail } = await markFailed(prisma, runId, message, kind);
      if (shouldEmail) {
        let free: number | null = null;
        try {
          free = await deps.freeBytes(cfg.tempDir);
        } catch {
          free = null;
        }
        await notifier.failed({ month, phase, error: message, kind, freeBytes: free });
      }
    } catch (failErr) {
      log(`Falha ao registrar erro do run ${runId}: ${errorMessage(failErr)}`);
    }
  }
}
