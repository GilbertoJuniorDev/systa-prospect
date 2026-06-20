import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMP_DIR = path.resolve('./temp');
const PROGRESSO_FILE = path.resolve('./temp/.progresso.json');

// ─── Escape para COPY text format ─────────────────────────────────────────────

function escapeCopy(value: string | null): string {
  if (value === null) return '\\N';
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ─── Progresso ────────────────────────────────────────────────────────────────

function carregarProgresso(): Set<string> {
  if (!fs.existsSync(PROGRESSO_FILE)) return new Set();
  const dados = JSON.parse(fs.readFileSync(PROGRESSO_FILE, 'utf-8')) as string[];
  return new Set(dados);
}

function salvarProgresso(concluidos: Set<string>): void {
  fs.writeFileSync(PROGRESSO_FILE, JSON.stringify([...concluidos]), 'utf-8');
}

// ─── Listar arquivos ──────────────────────────────────────────────────────────

function listarArquivos(dir: string, extensao: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toUpperCase().endsWith(extensao.toUpperCase()))
    .map((f) => path.join(dir, f))
    .sort();
}

// ─── Processar arquivo via COPY ───────────────────────────────────────────────

async function processarArquivo(caminho: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let totalLinhas = 0;

  try {
    // Staging table sem índices: o COPY escreve na velocidade máxima
    await client.query(`
      CREATE TEMP TABLE empresa_staging (
        cnpj_base         VARCHAR(8),
        razao_social      TEXT,
        natureza_juridica VARCHAR(4),
        qualificacao_resp VARCHAR(2),
        capital_social    DOUBLE PRECISION,
        porte             VARCHAR(2),
        ente_federativo   TEXT
      )
    `);

    const copyStream = client.query(
      copyFrom(
        "COPY empresa_staging FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')",
      ),
    );

    // Transform: row do csv-parser → linha TSV para o protocolo COPY
    const rowTransform = new Transform({
      readableObjectMode: false,
      writableObjectMode: true,
      transform(row: Record<number | string, string>, _enc, cb) {
        totalLinhas++;

        const cnpj_base = (row[0] ?? '').trim();
        if (!cnpj_base) { cb(); return; }

        const capitalStr = (row[4] ?? '0').trim().replace(',', '.') || '0';
        const ente = (row[6] ?? '').trim() || null;

        const line = [
          escapeCopy(cnpj_base),
          escapeCopy((row[1] ?? '').trim()),
          escapeCopy((row[2] ?? '').trim()),
          escapeCopy((row[3] ?? '').trim()),
          escapeCopy(capitalStr),
          escapeCopy((row[5] ?? '').trim()),
          escapeCopy(ente),
        ].join('\t') + '\n';

        if (totalLinhas % 100_000 === 0) {
          process.stdout.write(
            `\r  Linhas enviadas: ${totalLinhas.toLocaleString('pt-BR')}`,
          );
        }

        cb(null, line);
      },
    });

    // Pipeline contínuo: arquivo → encoding → csv → tsv → postgres COPY
    await pipeline(
      fs.createReadStream(caminho),
      iconv.decodeStream('win1252'),
      csvParser({ separator: ';', headers: false, skipComments: true }),
      rowTransform,
      copyStream,
    );

    // Move da staging para a tabela definitiva, ignorando duplicatas
    const resultado = await client.query(`
      INSERT INTO "Empresa" (cnpj_base, razao_social, natureza_juridica,
                             qualificacao_resp, capital_social, porte, ente_federativo)
      SELECT cnpj_base, razao_social, natureza_juridica,
             qualificacao_resp, capital_social, porte, ente_federativo
      FROM empresa_staging
      ON CONFLICT (cnpj_base) DO NOTHING
    `);

    await client.query('DROP TABLE empresa_staging');

    process.stdout.write('\n');
    console.log(
      `  Total: ${totalLinhas.toLocaleString('pt-BR')} linhas | ${(resultado.rowCount ?? 0).toLocaleString('pt-BR')} inseridas no banco`,
    );
  } catch (err) {
    await client.query('DROP TABLE IF EXISTS empresa_staging').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const arquivos = listarArquivos(TEMP_DIR, '.EMPRECSV');

  if (arquivos.length === 0) {
    console.log('Nenhum arquivo .EMPRECSV encontrado na pasta temp/.');
    return;
  }

  console.log(
    `🔍 ${arquivos.length} arquivo(s) .EMPRECSV encontrado(s). Iniciando ingestão...`,
  );

  const concluidos = carregarProgresso();

  for (let i = 0; i < arquivos.length; i++) {
    const arquivo = arquivos[i];
    const nome = path.basename(arquivo);

    if (concluidos.has(nome)) {
      console.log(`⏭️  Pulando (já processado): ${nome}`);
      continue;
    }

    console.log(`\n📄 [${i + 1}/${arquivos.length}] Processando: ${nome}`);
    const inicio = Date.now();

    await processarArquivo(arquivo);

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`✅ Concluído em ${duracao}s: ${nome}`);

    concluidos.add(nome);
    salvarProgresso(concluidos);
  }

  console.log('\n🎉 Todos os arquivos foram processados com sucesso!');

  console.log('\n🔧 Criando índice GIN para busca por razão social...');
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_razao_social_trgm
     ON "Empresa" USING gin (razao_social gin_trgm_ops);`,
  );
  console.log('✅ Índice criado com sucesso!');
}

main()
  .catch((err) => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
