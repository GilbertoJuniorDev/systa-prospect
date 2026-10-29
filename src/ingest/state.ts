import type { PrismaClient } from '@prisma/client';
import type { IngestConfig } from './config';
import type { OpenRun } from './decide';
import { PermanentError } from './errors';
import { zipTable } from './tables';
import type { DavEntry } from './webdav';

// ─── Constantes ──────────────────────────────────────────────────────────────

const EMAIL_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** `phase` do SUCCESS sintético do primeiro deploy (base carregada antes do agendador). */
export const BOOTSTRAP_PHASE = 'bootstrap';

/** Usado em `pg.Client` dentro da transação da carga. Parâmetros: runId, fileName, rows, discarded. */
export const MARK_INGESTED_SQL =
  `UPDATE "IngestFile" SET status='INGESTED', rows=$3, discarded=$4, "ingestedAt"=now() WHERE "runId"=$1 AND "fileName"=$2`;

// ─── Consultas ───────────────────────────────────────────────────────────────

export async function getLastSuccess(
  prisma: PrismaClient,
): Promise<{ month: string; finishedAt: Date; phase: string | null } | null> {
  const run = await prisma.ingestRun.findFirst({
    where: { status: 'SUCCESS', finishedAt: { not: null } },
    orderBy: { finishedAt: 'desc' },
  });
  if (!run || !run.finishedAt) return null;
  return { month: run.month, finishedAt: run.finishedAt, phase: run.phase };
}

/**
 * Run mais recente (por startedAt) em RUNNING|FAILED, desde que nenhum
 * SUCCESS posterior o tenha tornado obsoleto. ABANDONED é ignorado.
 */
export async function getOpenRun(prisma: PrismaClient): Promise<OpenRun | null> {
  const run = await prisma.ingestRun.findFirst({
    where: { status: { in: ['RUNNING', 'FAILED'] } },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) return null;

  const laterSuccess = await prisma.ingestRun.findFirst({
    where: { status: 'SUCCESS', startedAt: { gt: run.startedAt } },
    select: { id: true },
  });
  if (laterSuccess) return null;

  return {
    id: run.id,
    month: run.month,
    status: run.status as 'RUNNING' | 'FAILED',
    errorKind: run.errorKind,
    finishedAt: run.finishedAt,
  };
}

/**
 * Base "suja" = algum run (qualquer status, inclusive ABANDONED/FAILED) chegou a
 * truncá-la (prepared=true) depois do último SUCCESS. Nesse caso a base atual
 * não é mais a do último mês carregado e nenhum run pode ser abandonado em silêncio.
 */
export async function isBaseDirty(prisma: PrismaClient): Promise<boolean> {
  const lastSuccess = await prisma.ingestRun.findFirst({
    where: { status: 'SUCCESS' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  const dirty = await prisma.ingestRun.findFirst({
    where: {
      prepared: true,
      ...(lastSuccess ? { startedAt: { gt: lastSuccess.startedAt } } : {}),
    },
    select: { id: true },
  });
  return dirty !== null;
}

export async function latestRunStatus(
  prisma: PrismaClient,
): Promise<{ month: string | null; loadedAt: Date | null; maintenance: boolean }> {
  const [last, open] = await Promise.all([getLastSuccess(prisma), getOpenRun(prisma)]);
  return {
    month: last?.month ?? null,
    // Bootstrap não é uma carga: a data dele (o deploy) não pode marcar caches como defasados.
    loadedAt: last && last.phase !== BOOTSTRAP_PHASE ? last.finishedAt : null,
    maintenance: open !== null,
  };
}

// ─── Ciclo de vida do run ────────────────────────────────────────────────────

export async function createRun(prisma: PrismaClient, month: string): Promise<string> {
  const run = await prisma.ingestRun.create({ data: { month, status: 'RUNNING' } });
  return run.id;
}

export async function abandonRun(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.ingestRun.update({ where: { id: runId }, data: { status: 'ABANDONED' } });
}

/** Retoma um run (ex.: FAILED): volta a RUNNING e limpa finishedAt. */
export async function markRunning(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.ingestRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', finishedAt: null },
  });
}

export async function markPrepared(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.ingestRun.update({ where: { id: runId }, data: { prepared: true } });
}

export async function setPhase(prisma: PrismaClient, runId: string, phase: string): Promise<void> {
  await prisma.ingestRun.update({ where: { id: runId }, data: { phase } });
}

export async function markSuccess(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.ingestRun.update({
    where: { id: runId },
    data: { status: 'SUCCESS', finishedAt: new Date(), error: null, errorKind: null },
  });
}

/** Registra a falha; `shouldEmail` limita o e-mail a no máximo um a cada 6 h. */
export async function markFailed(
  prisma: PrismaClient,
  runId: string,
  error: string,
  kind: 'TEMPORARY' | 'PERMANENT',
): Promise<{ shouldEmail: boolean }> {
  const run = await prisma.ingestRun.findUniqueOrThrow({
    where: { id: runId },
    select: { lastFailureEmailAt: true },
  });
  const now = new Date();
  const shouldEmail =
    run.lastFailureEmailAt === null ||
    now.getTime() - run.lastFailureEmailAt.getTime() > EMAIL_THROTTLE_MS;

  await prisma.ingestRun.update({
    where: { id: runId },
    data: {
      status: 'FAILED',
      error,
      errorKind: kind,
      finishedAt: now,
      ...(shouldEmail ? { lastFailureEmailAt: now } : {}),
    },
  });
  return { shouldEmail };
}

// ─── Arquivos ────────────────────────────────────────────────────────────────

/** Idempotente: não duplica nem reseta o status de arquivos já registrados. */
export async function registerFiles(
  prisma: PrismaClient,
  runId: string,
  entries: DavEntry[],
): Promise<void> {
  const data = entries
    .filter((e) => !e.isDir && e.size !== null)
    .map((e) => {
      const tableName = zipTable(e.name);
      return {
        runId,
        fileName: e.name,
        size: BigInt(e.size as number),
        tableName,
        status: tableName === null ? ('SKIPPED' as const) : ('PENDING' as const),
      };
    });
  if (data.length === 0) return;
  await prisma.ingestFile.createMany({ data, skipDuplicates: true });
}

export async function pendingFiles(
  prisma: PrismaClient,
  runId: string,
): Promise<{ fileName: string; size: number; tableName: string }[]> {
  const files = await prisma.ingestFile.findMany({
    where: { runId, status: 'PENDING' },
    orderBy: { fileName: 'asc' },
  });
  return files.map((f) => ({
    fileName: f.fileName,
    size: Number(f.size),
    tableName: f.tableName as string,
  }));
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Primeiro deploy com base já carregada: registra o mês existente como SUCCESS.
 * Sem INGEST_MONTH nesse cenário, falha de forma permanente.
 */
export async function bootstrapIfNeeded(
  prisma: PrismaClient,
  cfg: IngestConfig,
  log: (m: string) => void,
): Promise<void> {
  if ((await prisma.ingestRun.count()) !== 0) return;

  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "Empresa" LIMIT 1) AS "exists"`;
  if (!rows[0]?.exists) return;

  if (!cfg.bootstrapMonth) {
    const msg = 'INGEST_MONTH obrigatório no primeiro deploy com base já carregada';
    log(msg);
    throw new PermanentError(msg);
  }

  await prisma.ingestRun.create({
    data: {
      month: cfg.bootstrapMonth,
      status: 'SUCCESS',
      prepared: true,
      phase: BOOTSTRAP_PHASE,
      finishedAt: new Date(),
    },
  });
  log(`Base já carregada registrada como mês ${cfg.bootstrapMonth}`);
}
