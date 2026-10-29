// ─── Classes de erro ─────────────────────────────────────────────────────────

export class TemporaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporaryError';
  }
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export class DiskSpaceError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'DiskSpaceError';
  }
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ─── Classificação ───────────────────────────────────────────────────────────

const TEMPORARY_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P01', // admin_shutdown (Postgres)
  '57P02', // crash_shutdown (Postgres)
  '57P03', // cannot_connect_now (Postgres)
  // Prisma: banco inacessível / timeout / conexão fechada pelo servidor.
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

const TEMPORARY_MESSAGES = ['socket hang up', 'Connection terminated'];

function isTemporaryCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  // Classe 08 do Postgres: connection_exception e afins.
  return TEMPORARY_CODES.has(code) || code.startsWith('08');
}

function classifyOwn(err: unknown): 'TEMPORARY' | 'PERMANENT' | null {
  if (err instanceof TemporaryError) return 'TEMPORARY';
  if (err instanceof PermanentError) return 'PERMANENT';
  if (err instanceof HttpError) {
    return err.status >= 500 || err.status === 429 ? 'TEMPORARY' : 'PERMANENT';
  }

  const e = err as any;
  if (isTemporaryCode(e?.code) || isTemporaryCode(e?.errorCode)) return 'TEMPORARY';
  if (e?.name === 'PrismaClientInitializationError') return 'TEMPORARY';

  const message = err instanceof Error ? err.message : '';
  if (TEMPORARY_MESSAGES.some((m) => message.includes(m))) return 'TEMPORARY';

  return null;
}

/**
 * Erros temporários são re-tentados depois; qualquer outro erro (inclusive
 * não classificado) é permanente, para não martelar a Receita a cada 30 min.
 * Olha também, uma vez, `err.cause` (erros embrulhados por drivers/Prisma).
 */
export function classifyError(err: unknown): 'TEMPORARY' | 'PERMANENT' {
  const own = classifyOwn(err);
  if (own !== null) return own;
  const cause = (err as any)?.cause;
  if (cause !== undefined && cause !== null) return classifyOwn(cause) ?? 'PERMANENT';
  return 'PERMANENT';
}
