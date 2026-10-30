// ─── Tipos ───────────────────────────────────────────────────────────────────

export type Trigger = 'startup' | 'daily' | 'retry' | 'manual';

export interface OpenRun {
  id: string;
  month: string;
  status: 'RUNNING' | 'FAILED';
  errorKind: 'TEMPORARY' | 'PERMANENT' | null;
  finishedAt: Date | null;
}

export interface DecideInput {
  trigger: Trigger;
  lastSuccessMonth: string | null;
  openRun: OpenRun | null;
  latestRemote: string | null;
  forcedMonth?: string;
}

export type Decision =
  | { kind: 'none'; reason: string }
  | { kind: 'resume'; runId: string }
  | { kind: 'start'; month: string; abandonRunId?: string };

const RETRY_MS = 30 * 60 * 1000;

// ─── Decisão ─────────────────────────────────────────────────────────────────

export function decideNext(i: DecideInput): Decision {
  const { trigger, lastSuccessMonth, openRun, latestRemote, forcedMonth } = i;

  // 1. Mês forçado (manual)
  if (trigger === 'manual' && forcedMonth) {
    if (openRun && openRun.month === forcedMonth) return { kind: 'resume', runId: openRun.id };
    return openRun
      ? { kind: 'start', month: forcedMonth, abandonRunId: openRun.id }
      : { kind: 'start', month: forcedMonth };
  }

  // 2. Run em andamento (ex.: processo caiu) → retoma
  if (openRun && openRun.status === 'RUNNING') return { kind: 'resume', runId: openRun.id };

  // 3. Boot só retoma RUNNING
  if (trigger === 'startup') return { kind: 'none', reason: 'startup sem run em andamento' };

  // 4. Run FAILED aberto
  if (openRun && openRun.status === 'FAILED') {
    if (latestRemote !== null && latestRemote > openRun.month) {
      return { kind: 'start', month: latestRemote, abandonRunId: openRun.id };
    }
    if (trigger === 'retry' && openRun.errorKind !== 'TEMPORARY') {
      return { kind: 'none', reason: 'falha permanente aguarda o próximo ciclo diário' };
    }
    return { kind: 'resume', runId: openRun.id };
  }

  // 5. Sem informação do servidor
  if (latestRemote === null) return { kind: 'none', reason: 'nenhum mês disponível no servidor' };

  // 6. Mês novo?
  if (lastSuccessMonth === null || latestRemote > lastSuccessMonth) {
    return { kind: 'start', month: latestRemote };
  }
  return { kind: 'none', reason: `base já está no mês ${lastSuccessMonth}` };
}

export function latestMonth(folders: string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    if (!/^\d{4}-\d{2}$/.test(f)) continue;
    if (best === null || f > best) best = f;
  }
  return best;
}

// ─── Agenda ──────────────────────────────────────────────────────────────────

/**
 * Próximo instante com hora local == `hour`:00 (no fuso `timeZone`), estritamente
 * após `now`. Não depende do fuso do host: avança de 15 em 15 min (todo offset
 * real é múltiplo de 15 min) e olha as partes locais via Intl.
 */
export function nextDailyRun(now: Date, hour: number, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const STEP = 15 * 60 * 1000;
  let t = Math.floor(now.getTime() / STEP) * STEP + STEP;
  const limit = t + 72 * 60 * 60 * 1000;
  for (; t <= limit; t += STEP) {
    const parts = fmt.formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (h === hour && m === 0) return new Date(t);
  }
  throw new Error(`não foi possível calcular a próxima execução para hora ${hour} em ${timeZone}`);
}

export function nextWakeUp(
  now: Date,
  daily: Date,
  openRun: OpenRun | null,
): { at: Date; trigger: 'daily' | 'retry' } {
  // Ciclo terminou com run ainda RUNNING (ex.: markFailed não gravou): retoma em 30 min.
  if (openRun && openRun.status === 'RUNNING') {
    const retryAt = new Date(now.getTime() + RETRY_MS);
    if (retryAt.getTime() < daily.getTime()) return { at: retryAt, trigger: 'retry' };
  }
  if (openRun && openRun.status === 'FAILED' && openRun.errorKind === 'TEMPORARY') {
    const retryAt = new Date((openRun.finishedAt ?? now).getTime() + RETRY_MS);
    if (retryAt.getTime() < daily.getTime()) return { at: retryAt, trigger: 'retry' };
  }
  return { at: daily, trigger: 'daily' };
}
