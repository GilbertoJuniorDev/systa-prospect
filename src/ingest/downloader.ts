import http from 'http';
import https from 'https';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { classifyError, HttpError, TemporaryError } from './errors';

// ─── Tipos e constantes ──────────────────────────────────────────────────────

export interface DownloadOptions {
  url: string;
  dest: string;
  size: number;
  headers: Record<string, string>;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  idleTimeoutMs?: number;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 300_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 10 s, 20 s, 40 s, 80 s... com teto de 300 s. `attempt` começa em 1. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

// ─── Requisição ──────────────────────────────────────────────────────────────

interface Opened {
  req: http.ClientRequest;
  res: http.IncomingMessage;
}

/** Abre a requisição seguindo redirects (até 5) e devolve a resposta final. */
function openResponse(
  urlStr: string,
  headers: Record<string, string>,
  idleTimeoutMs: number,
  redirects = 0,
): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          res.resume();
          const loc = res.headers.location;
          if (!loc) {
            reject(new HttpError(status, `Redirecionamento HTTP ${status} sem Location`));
            return;
          }
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error('Muitos redirecionamentos'));
            return;
          }
          const next = new URL(loc, parsed);
          const nextHeaders = { ...headers };
          if (next.host !== parsed.host) {
            for (const key of Object.keys(nextHeaders)) {
              if (key.toLowerCase() === 'authorization') delete nextHeaders[key];
            }
          }
          openResponse(next.toString(), nextHeaders, idleTimeoutMs, redirects + 1).then(resolve, reject);
          return;
        }

        resolve({ req, res });
      },
    );

    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(Object.assign(new Error('Timeout de inatividade do socket'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
  });
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function removeIfExists(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Aguarda o descritor do arquivo ser de fato fechado (Windows não apaga/trunca arquivo aberto). */
function closed(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('close', () => resolve());
    if (!stream.destroyed) stream.destroy();
  });
}

// ─── Uma tentativa ───────────────────────────────────────────────────────────

async function attemptDownload(opts: DownloadOptions, idleTimeoutMs: number): Promise<void> {
  const { url, dest, size, headers, log } = opts;

  for (let restarted = false; ; ) {
    let local = sizeOf(dest);
    if (local === size) return;
    if (local > size) {
      removeIfExists(dest);
      local = 0;
    }

    const reqHeaders = local > 0 ? { ...headers, Range: `bytes=${local}-` } : { ...headers };
    const { req, res } = await openResponse(url, reqHeaders, idleTimeoutMs);
    const status = res.statusCode ?? 0;

    if (status === 416 && local > 0 && !restarted) {
      res.resume();
      log?.(`Servidor recusou o Range (416); descartando parcial de ${local} bytes e baixando do zero`);
      removeIfExists(dest);
      restarted = true;
      continue;
    }

    if (status !== 200 && status !== 206) {
      res.resume();
      throw new HttpError(status, `HTTP ${status} ao baixar ${url}`);
    }

    // 206 → continua do ponto; 200 (servidor ignorou Range) → recomeça do zero.
    const append = status === 206 && local > 0;
    if (local > 0) {
      log?.(append ? `Retomando download a partir de ${local} bytes` : 'Servidor ignorou o Range; baixando do zero');
    }

    req.on('error', (err) => res.destroy(err));
    const out = fs.createWriteStream(dest, { flags: append ? 'a' : 'w' });
    try {
      await pipeline(res, out);
    } catch (err) {
      await closed(out);
      if ((err as any)?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        throw new TemporaryError('Conexão encerrada antes do fim do download');
      }
      throw err;
    }
    await closed(out);

    const finalSize = sizeOf(dest);
    if (finalSize !== size) {
      throw new TemporaryError(`Download incompleto: ${finalSize} de ${size} bytes`);
    }
    return;
  }
}

// ─── Download com retry ──────────────────────────────────────────────────────

export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      await attemptDownload(opts, idleTimeoutMs);
      return;
    } catch (err) {
      if (classifyError(err) === 'PERMANENT' || attempt >= maxAttempts) throw err;
      const wait = backoffMs(attempt);
      opts.log?.(
        `Tentativa ${attempt}/${maxAttempts} falhou (${err instanceof Error ? err.message : String(err)}); nova tentativa em ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}
