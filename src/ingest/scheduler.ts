import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { createTransporter } from '../services/email.service';
import { PermanentError } from './errors';
import { loadIngestConfig, type IngestConfig } from './config';
import { connect, tryAdvisoryLock } from './db';
import { decideNext, latestMonth, nextDailyRun, nextWakeUp, type Decision, type Trigger } from './decide';
import { freeBytes } from './disk';
import { downloadFile } from './downloader';
import { loadCsv } from './loader';
import { createNotifier } from './notify';
import { executeRun, extractZip, type RunDeps } from './run';
import { abandonRun, bootstrapIfNeeded, createRun, getLastSuccess, getOpenRun } from './state';
import { listMonthFiles, listRemoteMonths } from './webdav';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface TickResult {
  decision: Decision;
  /** Run em que o tick agiu (retomado ou criado); ausente quando a decisão foi `none`. */
  runId?: string;
}

export type TickDeps = RunDeps & {
  listRemoteMonths: typeof listRemoteMonths;
  /** Substituível em testes. */
  executeRun?: typeof executeRun;
};

const RETRY_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// ─── Tick ────────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Erro de bootstrap permanente (INGEST_MONTH ausente) bloqueia a ingestão; os demais são tentados de novo. */
export function bootstrapOutcome(err: unknown): 'permanent' | 'retry' {
  return err instanceof PermanentError ? 'permanent' : 'retry';
}

/**
 * Uma verificação/execução. Só uma instância por vez (advisory lock no banco).
 * Lança se o estado no banco não puder ser lido (ex.: banco fora do ar); falhas
 * de run são tratadas dentro de executeRun, que nunca rejeita.
 */
export async function tick(
  trigger: Trigger,
  deps: TickDeps,
  forcedMonth?: string,
): Promise<TickResult> {
  const { prisma, db, log } = deps;
  const exec = deps.executeRun ?? executeRun;

  if (!(await tryAdvisoryLock(db))) {
    log(`[${trigger}] outra instância está executando; nada a fazer`);
    return { decision: { kind: 'none', reason: 'lock ocupado' } };
  }

  try {
    const [lastSuccess, openRun] = await Promise.all([getLastSuccess(prisma), getOpenRun(prisma)]);

    // Startup só retoma RUNNING e mês forçado dispensa consulta: não lista o servidor.
    let latestRemote: string | null = null;
    if (trigger !== 'startup' && !(trigger === 'manual' && forcedMonth)) {
      try {
        latestRemote = latestMonth(await deps.listRemoteMonths(deps.cfg));
      } catch (err) {
        log(`[${trigger}] falha ao listar meses no servidor: ${errorMessage(err)}`);
      }
    }

    const decision = decideNext({
      trigger,
      lastSuccessMonth: lastSuccess?.month ?? null,
      openRun,
      latestRemote,
      forcedMonth,
    });

    if (decision.kind === 'none') {
      log(`[${trigger}] nada a fazer: ${decision.reason}`);
      return { decision };
    }
    if (decision.kind === 'resume') {
      log(`[${trigger}] retomando run ${decision.runId}`);
      await exec(decision.runId, deps);
      return { decision, runId: decision.runId };
    }
    if (decision.abandonRunId) {
      log(`[${trigger}] abandonando run ${decision.abandonRunId}`);
      await abandonRun(prisma, decision.abandonRunId);
    }
    log(`[${trigger}] iniciando mês ${decision.month}`);
    const runId = await createRun(prisma, decision.month);
    await exec(runId, deps);
    return { decision, runId };
  } finally {
    await db.query('SELECT pg_advisory_unlock(727011)').catch(() => {});
  }
}

// ─── Montagem de dependências ────────────────────────────────────────────────

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

export function buildDeps(cfg: IngestConfig, prisma: PrismaClient, db: Client): TickDeps {
  return {
    cfg,
    prisma,
    db,
    listMonthFiles,
    listRemoteMonths,
    downloadFile,
    extractZip,
    loadCsv,
    freeBytes,
    notifier: createNotifier(cfg, createTransporter(), log),
    log,
  };
}

/** Abre uma conexão nova, executa `fn` e fecha — um banco reiniciado não envenena o processo. */
export async function withFreshDb<T>(
  cfg: IngestConfig,
  prisma: PrismaClient,
  fn: (deps: TickDeps) => Promise<T>,
): Promise<T> {
  const db = await connect(cfg.databaseUrl);
  try {
    return await fn(buildDeps(cfg, prisma, db));
  } finally {
    await db.end().catch(() => {});
  }
}

// ─── Entrypoint de longa duração ─────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadIngestConfig(process.env);
  const prisma = new PrismaClient();

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let running = false;
  let bootstrapped = false;
  let bootstrapFailed = false;
  const notifier = createNotifier(cfg, createTransporter(), log);

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} recebido; encerrando (um run em andamento é retomado na próxima inicialização)`);
    if (timer) clearTimeout(timer);
    prisma
      .$disconnect()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  function schedule(trigger: Trigger, at: Date): void {
    if (stopping) return;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, at.getTime() - Date.now()));
    log(`Próxima execução (${trigger}) em ${at.toISOString()}`);
    timer = setTimeout(() => void cycle(trigger), delay);
  }

  /** Tenta o bootstrap até dar certo; só erro permanente trava a ingestão (e avisa por e-mail uma vez). */
  async function ensureBootstrap(): Promise<void> {
    if (bootstrapped || bootstrapFailed) return;
    try {
      await bootstrapIfNeeded(prisma, cfg, log);
      bootstrapped = true;
    } catch (err) {
      if (bootstrapOutcome(err) === 'retry') throw err;
      bootstrapFailed = true;
      const msg = errorMessage(err);
      log(`Bootstrap falhou: ${msg}. Serviço ativo, mas sem ingestão até reiniciar com INGEST_MONTH.`);
      await notifier
        .failed({ month: '—', phase: 'bootstrap', error: msg, kind: 'PERMANENT', freeBytes: null })
        .catch((e) => log(`Falha ao notificar bootstrap: ${errorMessage(e)}`));
    }
  }

  async function cycle(trigger: Trigger): Promise<void> {
    if (running || stopping) return;
    running = true;
    try {
      await ensureBootstrap();
      if (bootstrapFailed) {
        log(`[${trigger}] ignorado: defina INGEST_MONTH e reinicie o serviço (bootstrap pendente)`);
      } else {
        await withFreshDb(cfg, prisma, (deps) => tick(trigger, deps));
      }
      const now = new Date();
      const daily = nextDailyRun(now, cfg.cronHour, cfg.timeZone);
      const wake = nextWakeUp(now, daily, bootstrapFailed ? null : await getOpenRun(prisma));
      schedule(wake.trigger, wake.at);
    } catch (err) {
      log(`Erro no ciclo ${trigger}: ${errorMessage(err)}; nova tentativa em 30 minutos`);
      schedule('retry', new Date(Date.now() + RETRY_MS));
    } finally {
      running = false;
    }
  }

  log(`Agendador iniciado (hora ${cfg.cronHour}, fuso ${cfg.timeZone})`);
  await cycle('startup');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Falha fatal no agendador:', err);
    process.exit(1);
  });
}
