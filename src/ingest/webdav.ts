import https from 'https';
import { IngestConfig } from './config';
import { HttpError } from './errors';

// ─── Tipos e constantes ──────────────────────────────────────────────────────

export interface DavEntry {
  name: string;
  href: string;
  size: number | null;
  isDir: boolean;
}

export const DAV_HOST = 'arquivos.receitafederal.gov.br';
const DAV_ROOT_PATH = '/public.php/webdav/';
const REQUEST_TIMEOUT_MS = 60_000;

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';

export function davAuthHeader(cfg: IngestConfig): string {
  return `Basic ${Buffer.from(`${cfg.shareToken}:`).toString('base64')}`;
}

export function davMonthUrl(month: string): string {
  return `https://${DAV_HOST}${DAV_ROOT_PATH}${encodeURIComponent(month)}/`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeDecodeURIComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Interpreta um multistatus de PROPFIND (Depth: 1). A primeira entrada é a
 * própria pasta consultada e é ignorada.
 */
export function parsePropfind(xml: string): DavEntry[] {
  const blocks = xml.match(/<[Dd]:response>[\s\S]*?<\/[Dd]:response>/g) ?? [];
  const entries: DavEntry[] = [];

  for (const block of blocks.slice(1)) {
    const hrefMatch = block.match(/<[Dd]:href>([^<]+)<\/[Dd]:href>/);
    if (!hrefMatch) continue;

    const href = safeDecodeURIComponent(decodeXmlEntities(hrefMatch[1].trim()));
    const nameMatch = block.match(/<[Dd]:displayname>([^<]*)<\/[Dd]:displayname>/);
    const sizeMatch = block.match(/<[Dd]:getcontentlength>(\d+)<\/[Dd]:getcontentlength>/);
    const typeMatch = block.match(/<[Dd]:resourcetype>([\s\S]*?)<\/[Dd]:resourcetype>/);

    const name =
      decodeXmlEntities(nameMatch?.[1]?.trim() ?? '') || href.replace(/\/+$/, '').split('/').pop() || '';
    if (!name) continue;

    entries.push({
      name,
      href,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : null,
      isDir: typeMatch ? /<[Dd]:collection\b/.test(typeMatch[1]) : false,
    });
  }

  return entries;
}

// ─── Requisição ──────────────────────────────────────────────────────────────

function propfind(cfg: IngestConfig, urlStr: string): Promise<DavEntry[]> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'PROPFIND',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          Authorization: davAuthHeader(cfg),
          Depth: '1',
          'Content-Type': 'application/xml',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 207) {
            reject(new HttpError(res.statusCode ?? 0, `PROPFIND retornou HTTP ${res.statusCode ?? 0}`));
            return;
          }
          resolve(parsePropfind(data));
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('PROPFIND timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.write(PROPFIND_BODY);
    req.end();
  });
}

/** Nomes das pastas (meses) disponíveis na raiz do compartilhamento. */
export async function listRemoteMonths(cfg: IngestConfig): Promise<string[]> {
  const entries = await propfind(cfg, `https://${DAV_HOST}${DAV_ROOT_PATH}`);
  return entries.filter((e) => e.isDir).map((e) => e.name);
}

/** Arquivos (não pastas) de um mês, com tamanho. */
export async function listMonthFiles(cfg: IngestConfig, month: string): Promise<DavEntry[]> {
  const entries = await propfind(cfg, davMonthUrl(month));
  return entries.filter((e) => !e.isDir);
}
