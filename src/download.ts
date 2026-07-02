import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';

const SHARE_TOKEN = process.env.SHARE_TOKEN;
if (!SHARE_TOKEN) {
  console.error('FATAL: variável de ambiente SHARE_TOKEN não definida.');
  process.exit(1);
}
const AUTH = Buffer.from(`${SHARE_TOKEN}:`).toString('base64');

const DIR = process.env.INGEST_MONTH ?? '2026-06';
const TEMP_DIR = path.resolve('./temp');
const WEBDAV_URL = `https://arquivos.receitafederal.gov.br/public.php/webdav/${DIR}/`;
const MB = 1_000_000;

interface Arquivo {
  nome: string;
  tamanho: number;
  href: string;
}

function requisicaoRaw(options: https.RequestOptions, method: string, body?: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, method }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body: data,
        })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listarArquivos(): Promise<Arquivo[]> {
  const url = new URL(WEBDAV_URL);
  const resp = await requisicaoRaw(
    {
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        Authorization: `Basic ${AUTH}`,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
    },
    'PROPFIND',
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>'
  );

  if (resp.status !== 207) {
    throw new Error(`PROPFIND retornou HTTP ${resp.status}. Verifique o token e o diretório.`);
  }

  const arquivos: Arquivo[] = [];
  const blocos = resp.body.match(/<[Dd]:response[\s\S]*?<\/[Dd]:response>/g) ?? [];

  for (const bloco of blocos) {
    const hrefMatch = bloco.match(/<[Dd]:href>([^<]+)<\/[Dd]:href>/);
    const sizeMatch = bloco.match(/<[Dd]:getcontentlength>(\d+)<\/[Dd]:getcontentlength>/);
    const nameMatch = bloco.match(/<[Dd]:displayname>([^<]*)<\/[Dd]:displayname>/);

    if (!hrefMatch || !sizeMatch) continue;

    const href = decodeURIComponent(hrefMatch[1].trim());
    const tamanho = parseInt(sizeMatch[1], 10);
    const nome = nameMatch?.[1]?.trim() || path.basename(href);

    if (!nome) continue;

    arquivos.push({ nome, tamanho, href });
  }

  return arquivos;
}

function baixarArquivo(arquivo: Arquivo): Promise<void> {
  return new Promise((resolve, reject) => {
    const nomeSanitizado = path.basename(arquivo.nome);
    if (!nomeSanitizado || nomeSanitizado !== arquivo.nome || nomeSanitizado.includes('\0')) {
      reject(new Error(`Nome de arquivo inválido: ${arquivo.nome}`));
      return;
    }

    const destino = path.join(TEMP_DIR, nomeSanitizado);

    if (fs.existsSync(destino)) {
      const tamanhoLocal = fs.statSync(destino).size;
      if (tamanhoLocal === arquivo.tamanho) {
        console.log(`[SKIP] ${arquivo.nome} (${(arquivo.tamanho / MB).toFixed(0)} MB já existe)`);
        resolve();
        return;
      }
      console.log(`[WARN] ${arquivo.nome} incompleto (${(tamanhoLocal / MB).toFixed(0)}/${(arquivo.tamanho / MB).toFixed(0)} MB) — rebaixando`);
      fs.unlinkSync(destino);
    }

    console.log(`[DOWN] ${arquivo.nome} — ${(arquivo.tamanho / MB).toFixed(0)} MB`);

    const fileStream = fs.createWriteStream(destino);
    let baixado = 0;
    let ultimoLogMB = 0;

    const fazGet = (urlStr: string, redirecoes = 0) => {
      if (redirecoes > 5) {
        reject(new Error('Muitos redirecionamentos'));
        return;
      }

      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;

      lib.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { Authorization: `Basic ${AUTH}` },
        },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const loc = res.headers.location;
            if (!loc) { reject(new Error('Redirecionamento sem Location')); return; }
            res.resume();
            fazGet(loc.startsWith('http') ? loc : `${parsed.origin}${loc}`, redirecoes + 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} ao baixar ${arquivo.nome}`));
            return;
          }

          res.on('data', (chunk: Buffer) => {
            baixado += chunk.length;
            const mbBaixado = baixado / MB;
            if (mbBaixado - ultimoLogMB >= 50) {
              const pct = ((baixado / arquivo.tamanho) * 100).toFixed(1);
              console.log(`       ${mbBaixado.toFixed(0)} / ${(arquivo.tamanho / MB).toFixed(0)} MB (${pct}%)`);
              ultimoLogMB = mbBaixado;
            }
          });

          res.pipe(fileStream);
          fileStream.on('finish', () => {
            console.log(`[OK]   ${arquivo.nome}`);
            resolve();
          });
          fileStream.on('error', reject);
          res.on('error', reject);
        }
      ).on('error', reject);
    };

    fazGet(`https://arquivos.receitafederal.gov.br${arquivo.href}`);
  });
}

function descompactarArquivo(nomeZip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(TEMP_DIR, nomeZip);

    const MAX_ZIP_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
    const stat = fs.statSync(zipPath);
    if (stat.size > MAX_ZIP_SIZE) {
      reject(new Error(`Arquivo ZIP excede o limite de 20 GB: ${nomeZip}`));
      return;
    }

    console.log(`[UNZIP] ${nomeZip}`);

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: TEMP_DIR }))
      .on('close', () => {
        console.log(`[UNZIP OK] ${nomeZip}`);
        resolve();
      })
      .on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  console.log(`Listando arquivos em /${DIR} ...`);
  const arquivos = await listarArquivos();

  if (arquivos.length === 0) {
    console.log('Nenhum arquivo encontrado.');
    return;
  }

  const totalMB = arquivos.reduce((acc, a) => acc + a.tamanho, 0) / MB;
  console.log(`${arquivos.length} arquivo(s) — ${totalMB.toFixed(0)} MB total\n`);

  for (const arquivo of arquivos) {
    const ehZip = arquivo.nome.toLowerCase().endsWith('.zip');
    const markerPath = path.join(TEMP_DIR, `${arquivo.nome}.done`);

    if (ehZip && fs.existsSync(markerPath)) {
      console.log(`[DONE]  ${arquivo.nome} (já extraído)`);
      continue;
    }

    await baixarArquivo(arquivo);

    if (ehZip) {
      await descompactarArquivo(arquivo.nome);

      const zipPath = path.join(TEMP_DIR, arquivo.nome);
      fs.unlinkSync(zipPath);
      console.log(`[DEL]   ${arquivo.nome}`);

      fs.writeFileSync(markerPath, '');
    }
  }

  console.log('\nConcluído. Execute "npm run ingest" para processar os dados.');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
