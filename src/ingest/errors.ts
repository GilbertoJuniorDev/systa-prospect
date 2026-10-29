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
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P03', // cannot_connect_now (Postgres)
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
]);

/**
 * Erros temporários são re-tentados depois; qualquer outro erro (inclusive
 * não classificado) é permanente, para não martelar a Receita a cada 30 min.
 */
export function classifyError(err: unknown): 'TEMPORARY' | 'PERMANENT' {
  if (err instanceof TemporaryError) return 'TEMPORARY';
  if (err instanceof PermanentError) return 'PERMANENT';
  if (err instanceof HttpError) {
    return err.status >= 500 || err.status === 429 ? 'TEMPORARY' : 'PERMANENT';
  }

  const code = (err as any)?.code;
  if (typeof code === 'string' && TEMPORARY_CODES.has(code)) return 'TEMPORARY';

  const message = err instanceof Error ? err.message : '';
  if (message.includes('socket hang up')) return 'TEMPORARY';

  return 'PERMANENT';
}
