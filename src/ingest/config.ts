import path from 'path';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface IngestConfig {
  shareToken: string;
  tempDir: string;
  cronHour: number;
  timeZone: string;
  bootstrapMonth: string | null;
  minFreeBytes: number;
  diskFactor: number;
  notifyEmails: string[];
  databaseUrl: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  const value = optional(raw);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} inválido: "${value}" (esperado número maior que zero)`);
  }
  return n;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export function loadIngestConfig(env: NodeJS.ProcessEnv): IngestConfig {
  const shareToken = optional(env.SHARE_TOKEN);
  if (!shareToken) throw new Error('SHARE_TOKEN ausente');

  const databaseUrl = optional(env.DATABASE_URL);
  if (!databaseUrl) throw new Error('DATABASE_URL ausente');

  const cronHourRaw = optional(env.INGEST_CRON_HOUR) ?? '2';
  const cronHour = Number(cronHourRaw);
  if (!/^\d+$/.test(cronHourRaw) || cronHour < 0 || cronHour > 23) {
    throw new Error(`INGEST_CRON_HOUR inválido: "${cronHourRaw}" (esperado 0–23)`);
  }

  const monthRaw = optional(env.INGEST_MONTH);
  if (monthRaw !== undefined && !MONTH_RE.test(monthRaw)) {
    throw new Error(`INGEST_MONTH inválido: "${monthRaw}" (esperado AAAA-MM)`);
  }

  return {
    shareToken,
    tempDir: path.resolve('./temp'),
    cronHour,
    timeZone: optional(env.TZ) ?? 'America/Sao_Paulo',
    bootstrapMonth: monthRaw ?? null,
    minFreeBytes: positiveNumber(env.INGEST_MIN_FREE_GB, 5, 'INGEST_MIN_FREE_GB') * GIB,
    diskFactor: positiveNumber(env.INGEST_DISK_FACTOR, 6, 'INGEST_DISK_FACTOR'),
    notifyEmails: (env.INGEST_NOTIFY_EMAIL ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0),
    databaseUrl,
  };
}
