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

// ─── Escape para COPY text format ────────────────────────────────────────────

function escapeCopy(value: string | null): string {
  if (value === null) return '\\N';
  return value
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function col(row: Record<number, string>, idx: number): string {
  return (row[idx] ?? '').trim();
}

function colOpt(row: Record<number, string>, idx: number): string | null {
  const v = (row[idx] ?? '').trim();
  return v === '' ? null : v;
}

// ─── DB connection with retry (handles 57P03 WAL recovery, ECONNREFUSED) ────

async function connectWithRetry(client: Client, maxAttempts = 10): Promise<void> {
  const RETRYABLE = new Set(['57P03', 'ECONNREFUSED', '08006', '08001', '08004']);
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connect();
      return;
    } catch (err: any) {
      const code = err?.code as string | undefined;
      if (!RETRYABLE.has(code ?? '') && !err?.message?.includes('ECONNREFUSED')) {
        throw err;
      }
      if (attempt === maxAttempts) throw err;
      console.log(`  ⏳ Banco indisponível (${code}), aguardando ${delay / 1000}s... (tentativa ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

// ─── Configuração por tipo de arquivo ────────────────────────────────────────

interface TabelaConfig {
  tabela: string;
  nameContains?: string;
  stagingDDL: string;
  copyColunas: string[];
  parseRow: (row: Record<number, string>) => (string | null)[];
  conflito: string | null;
  indexes: string[];
}

const CONFIGS: Record<string, TabelaConfig> = {
  '.EMPRECSV': {
    tabela: 'Empresa',
    stagingDDL: `
      CREATE TEMP TABLE empresa_staging (
        cnpj_base         VARCHAR(8),
        razao_social      TEXT,
        natureza_juridica VARCHAR(4),
        qualificacao_resp VARCHAR(2),
        capital_social    DOUBLE PRECISION,
        porte             VARCHAR(2),
        ente_federativo   TEXT
      )`,
    copyColunas: ['cnpj_base', 'razao_social', 'natureza_juridica', 'qualificacao_resp', 'capital_social', 'porte', 'ente_federativo'],
    parseRow: (row) => {
      const cnpj_base = col(row, 0);
      if (!cnpj_base) return [];
      const capitalStr = col(row, 4).replace(',', '.') || '0';
      return [
        cnpj_base,
        col(row, 1),
        col(row, 2),
        col(row, 3),
        capitalStr,
        col(row, 5),
        colOpt(row, 6),
      ];
    },
    conflito: 'ON CONFLICT (cnpj_base) DO NOTHING',
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_razao_social_trgm ON "Empresa" USING gin (razao_social gin_trgm_ops)`,
    ],
  },

  '.ESTABELE': {
    tabela: 'Estabelecimento',
    stagingDDL: `
      CREATE TEMP TABLE estabelecimento_staging (
        cnpj_base                   VARCHAR(8),
        cnpj_ordem                  VARCHAR(4),
        cnpj_dv                     VARCHAR(2),
        identificador_matriz_filial  VARCHAR(1),
        nome_fantasia               TEXT,
        situacao_cadastral          VARCHAR(2),
        data_situacao_cadastral     VARCHAR(8),
        motivo_situacao_cadastral   VARCHAR(2),
        nome_cidade_exterior        TEXT,
        pais                        VARCHAR(3),
        data_inicio_atividade       VARCHAR(8),
        cnae_fiscal_principal       VARCHAR(7),
        cnae_fiscal_secundaria      TEXT,
        tipo_logradouro             TEXT,
        logradouro                  TEXT,
        numero                      TEXT,
        complemento                 TEXT,
        bairro                      TEXT,
        cep                         VARCHAR(8),
        uf                          VARCHAR(2),
        municipio                   VARCHAR(4),
        ddd1                        VARCHAR(4),
        telefone1                   VARCHAR(9),
        ddd2                        VARCHAR(4),
        telefone2                   VARCHAR(9),
        ddd_fax                     VARCHAR(4),
        fax                         VARCHAR(9),
        correio_eletronico          TEXT,
        situacao_especial           TEXT,
        data_situacao_especial      VARCHAR(8)
      )`,
    copyColunas: [
      'cnpj_base', 'cnpj_ordem', 'cnpj_dv', 'identificador_matriz_filial',
      'nome_fantasia', 'situacao_cadastral', 'data_situacao_cadastral', 'motivo_situacao_cadastral',
      'nome_cidade_exterior', 'pais', 'data_inicio_atividade', 'cnae_fiscal_principal',
      'cnae_fiscal_secundaria', 'tipo_logradouro', 'logradouro', 'numero', 'complemento',
      'bairro', 'cep', 'uf', 'municipio', 'ddd1', 'telefone1', 'ddd2', 'telefone2',
      'ddd_fax', 'fax', 'correio_eletronico', 'situacao_especial', 'data_situacao_especial',
    ],
    parseRow: (row) => {
      const cnpj_base = col(row, 0);
      if (!cnpj_base) return [];
      return [
        cnpj_base, col(row, 1), col(row, 2), col(row, 3),
        colOpt(row, 4), col(row, 5), colOpt(row, 6), colOpt(row, 7),
        colOpt(row, 8), colOpt(row, 9), colOpt(row, 10), colOpt(row, 11),
        colOpt(row, 12), colOpt(row, 13), colOpt(row, 14), colOpt(row, 15), colOpt(row, 16),
        colOpt(row, 17), colOpt(row, 18), colOpt(row, 19), colOpt(row, 20),
        colOpt(row, 21), colOpt(row, 22), colOpt(row, 23), colOpt(row, 24),
        colOpt(row, 25), colOpt(row, 26), colOpt(row, 27), colOpt(row, 28), colOpt(row, 29),
      ];
    },
    conflito: 'ON CONFLICT (cnpj_base, cnpj_ordem, cnpj_dv) DO NOTHING',
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_estab_cnpj_base ON "Estabelecimento" (cnpj_base)`,
      `CREATE INDEX IF NOT EXISTS idx_estab_uf ON "Estabelecimento" (uf)`,
      `CREATE INDEX IF NOT EXISTS idx_estab_cnae ON "Estabelecimento" (cnae_fiscal_principal)`,
    ],
  },

  '.SOCIOCSV': {
    tabela: 'Socio',
    stagingDDL: `
      CREATE TEMP TABLE socio_staging (
        cnpj_base                  VARCHAR(8),
        identificador_socio        VARCHAR(1),
        nome_socio                 TEXT,
        cnpj_cpf_socio             VARCHAR(14),
        qualificacao_socio         VARCHAR(2),
        data_entrada_sociedade     VARCHAR(8),
        pais                       VARCHAR(3),
        representante_legal        VARCHAR(11),
        nome_representante         TEXT,
        qualificacao_representante VARCHAR(2),
        faixa_etaria               VARCHAR(1)
      )`,
    copyColunas: [
      'cnpj_base', 'identificador_socio', 'nome_socio', 'cnpj_cpf_socio',
      'qualificacao_socio', 'data_entrada_sociedade', 'pais', 'representante_legal',
      'nome_representante', 'qualificacao_representante', 'faixa_etaria',
    ],
    parseRow: (row) => {
      const cnpj_base = col(row, 0);
      if (!cnpj_base) return [];
      return [
        cnpj_base, col(row, 1), colOpt(row, 2), colOpt(row, 3),
        colOpt(row, 4), colOpt(row, 5), colOpt(row, 6), colOpt(row, 7),
        colOpt(row, 8), colOpt(row, 9), colOpt(row, 10),
      ];
    },
    conflito: null,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_socio_cnpj_base ON "Socio" (cnpj_base)`,
      `CREATE INDEX IF NOT EXISTS idx_socio_cpf ON "Socio" (cnpj_cpf_socio)`,
    ],
  },

  '.SIMPLECSV': {
    tabela: 'Simples',
    nameContains: 'SIMPLES',
    stagingDDL: `
      CREATE TEMP TABLE simples_staging (
        cnpj_base             VARCHAR(8),
        opcao_simples         VARCHAR(1),
        data_opcao_simples    VARCHAR(8),
        data_exclusao_simples VARCHAR(8),
        opcao_mei             VARCHAR(1),
        data_opcao_mei        VARCHAR(8),
        data_exclusao_mei     VARCHAR(8)
      )`,
    copyColunas: [
      'cnpj_base', 'opcao_simples', 'data_opcao_simples', 'data_exclusao_simples',
      'opcao_mei', 'data_opcao_mei', 'data_exclusao_mei',
    ],
    parseRow: (row) => {
      const cnpj_base = col(row, 0);
      if (!cnpj_base) return [];
      return [
        cnpj_base, colOpt(row, 1), colOpt(row, 2), colOpt(row, 3),
        colOpt(row, 4), colOpt(row, 5), colOpt(row, 6),
      ];
    },
    conflito: 'ON CONFLICT (cnpj_base) DO NOTHING',
    indexes: [],
  },

  '.CNAECSV': {
    tabela: 'Cnae',
    stagingDDL: `CREATE TEMP TABLE cnae_staging (codigo VARCHAR(7), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },

  '.MOTICSV': {
    tabela: 'Motivo',
    stagingDDL: `CREATE TEMP TABLE motivo_staging (codigo VARCHAR(2), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },

  '.MUNICCSV': {
    tabela: 'Municipio',
    stagingDDL: `CREATE TEMP TABLE municipio_staging (codigo VARCHAR(4), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },

  '.NATJUCSV': {
    tabela: 'Natureza',
    stagingDDL: `CREATE TEMP TABLE natureza_staging (codigo VARCHAR(4), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },

  '.PAISCSV': {
    tabela: 'Pais',
    stagingDDL: `CREATE TEMP TABLE pais_staging (codigo VARCHAR(3), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },

  '.QUALSCSV': {
    tabela: 'Qualificacao',
    stagingDDL: `CREATE TEMP TABLE qualificacao_staging (codigo VARCHAR(2), descricao TEXT)`,
    copyColunas: ['codigo', 'descricao'],
    parseRow: (row) => {
      const codigo = col(row, 0);
      if (!codigo) return [];
      return [codigo, col(row, 1)];
    },
    conflito: 'ON CONFLICT (codigo) DO NOTHING',
    indexes: [],
  },
};

// Ordem de ingestão: lookups primeiro, depois as tabelas grandes
const ORDEM_EXTENSOES = [
  '.CNAECSV', '.MOTICSV', '.MUNICCSV', '.NATJUCSV', '.PAISCSV', '.QUALSCSV',
  '.EMPRECSV', '.SIMPLECSV', '.ESTABELE', '.SOCIOCSV',
];

// ─── Progresso ───────────────────────────────────────────────────────────────

function carregarProgresso(): Set<string> {
  if (!fs.existsSync(PROGRESSO_FILE)) return new Set();
  const dados = JSON.parse(fs.readFileSync(PROGRESSO_FILE, 'utf-8')) as string[];
  return new Set(dados);
}

function salvarProgresso(concluidos: Set<string>): void {
  fs.writeFileSync(PROGRESSO_FILE, JSON.stringify([...concluidos]), 'utf-8');
}

// ─── Listar arquivos por extensão ────────────────────────────────────────────

function listarPorExtensao(dir: string, extensao: string, nameContains?: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) =>
      nameContains
        ? f.toUpperCase().includes(nameContains.toUpperCase())
        : f.toUpperCase().endsWith(extensao.toUpperCase()),
    )
    .map((f) => path.join(dir, f))
    .sort();
}

// ─── Processar arquivo via COPY ───────────────────────────────────────────────

async function processarArquivo(caminho: string, config: TabelaConfig): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await connectWithRetry(client);

  const nomeStaging = `${config.tabela.toLowerCase()}_staging`;
  let totalLinhas = 0;

  try {
    await client.query(config.stagingDDL);

    const colunasStr = config.copyColunas.map((c) => `"${c}"`).join(', ');
    const copyStream = client.query(
      copyFrom(
        `COPY ${nomeStaging} (${colunasStr}) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`,
      ),
    );

    const rowTransform = new Transform({
      readableObjectMode: false,
      writableObjectMode: true,
      transform(row: Record<number, string>, _enc, cb) {
        const valores = config.parseRow(row);
        if (valores.length === 0) { cb(); return; }

        totalLinhas++;
        const line = valores.map(escapeCopy).join('\t') + '\n';

        if (totalLinhas % 100_000 === 0) {
          process.stdout.write(`\r  Linhas enviadas: ${totalLinhas.toLocaleString('pt-BR')}`);
        }

        cb(null, line);
      },
    });

    await pipeline(
      fs.createReadStream(caminho),
      iconv.decodeStream('win1252'),
      csvParser({ separator: ';', headers: false, skipComments: true }),
      rowTransform,
      copyStream,
    );

    process.stdout.write('\n');

    // Para Socio não há chave natural única: INSERT direto sem ON CONFLICT
    if (config.conflito) {
      const resultado = await client.query(`
        INSERT INTO "${config.tabela}" (${colunasStr})
        SELECT ${colunasStr} FROM ${nomeStaging}
        ${config.conflito}
      `);
      console.log(
        `  Total: ${totalLinhas.toLocaleString('pt-BR')} linhas | ${(resultado.rowCount ?? 0).toLocaleString('pt-BR')} inseridas`,
      );
    } else {
      const resultado = await client.query(`
        INSERT INTO "${config.tabela}" (${colunasStr})
        SELECT ${colunasStr} FROM ${nomeStaging}
      `);
      console.log(
        `  Total: ${totalLinhas.toLocaleString('pt-BR')} linhas | ${(resultado.rowCount ?? 0).toLocaleString('pt-BR')} inseridas`,
      );
    }

    await client.query(`DROP TABLE ${nomeStaging}`);
  } catch (err) {
    await client.query(`DROP TABLE IF EXISTS ${nomeStaging}`).catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ─── Processamento paralelo com limite de concorrência ────────────────────────

async function processarComLimite(
  tasks: (() => Promise<void>)[],
  concorrencia: number,
): Promise<void> {
  const fila = [...tasks];
  async function worker() {
    while (fila.length > 0) {
      const task = fila.shift();
      if (task) await task();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concorrencia, tasks.length) }, worker));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Tabelas que se beneficiam de UNLOGGED durante carga (eliminam WAL no INSERT)
const TABELAS_GRANDES = new Set(['Empresa', 'Estabelecimento', 'Socio', 'Simples']);
const CONCORRENCIA = 3;

async function main(): Promise<void> {
  // Garante que nenhuma TABELA_GRANDE fique UNLOGGED após reinício inesperado
  for (const tabela of TABELAS_GRANDES) {
    const res = await prisma.$queryRawUnsafe<{ relpersistence: string }[]>(
      `SELECT relpersistence FROM pg_class WHERE relname = $1`,
      tabela,
    );
    if (res[0]?.relpersistence === 'u') {
      console.warn(`⚠️  "${tabela}" está UNLOGGED — restaurando para LOGGED antes de continuar...`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${tabela}" SET LOGGED`);
    }
  }

  const concluidos = carregarProgresso();
  const indexesCriados = new Set<string>();

  const grupos: Array<{ config: TabelaConfig; arquivos: string[] }> = [];
  let totalEncontrados = 0;

  for (const ext of ORDEM_EXTENSOES) {
    const config = CONFIGS[ext];
    const arquivos = listarPorExtensao(TEMP_DIR, ext, config.nameContains);
    if (arquivos.length > 0) {
      grupos.push({ config, arquivos });
      totalEncontrados += arquivos.length;
    }
  }

  if (totalEncontrados === 0) {
    console.log('Nenhum arquivo CSV encontrado em temp/. Execute "npm run download" primeiro.');
    return;
  }

  console.log(`\n🔍 ${totalEncontrados} arquivo(s) encontrado(s). Iniciando ingestão...\n`);

  for (const { config, arquivos } of grupos) {
    const pendentes = arquivos.filter((c) => !concluidos.has(path.basename(c)));

    if (pendentes.length === 0) {
      console.log(`⏭️  Todos os ${arquivos.length} arquivo(s) de "${config.tabela}" já processados.`);
      continue;
    }

    const isGrande = TABELAS_GRANDES.has(config.tabela);

    // Elimina WAL para INSERT em massa: 3-5× mais rápido
    if (isGrande) {
      console.log(`\n⚡ Configurando "${config.tabela}" como UNLOGGED para carga rápida...`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${config.tabela}" SET UNLOGGED`);
    }

    const concorrencia = isGrande ? CONCORRENCIA : 1;

    const tasks = pendentes.map((caminho) => async () => {
      const nome = path.basename(caminho);
      console.log(`\n📄 [${config.tabela}] ${nome}`);
      const inicio = Date.now();

      await processarArquivo(caminho, config);

      const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
      console.log(`✅ [${config.tabela}] ${nome} concluído em ${duracao}s`);

      // Node.js é single-threaded: safe sem mutex
      concluidos.add(nome);
      salvarProgresso(concluidos);

      try {
        fs.unlinkSync(caminho);
        console.log(`🗑️  Arquivo removido: ${nome}`);
      } catch {
        console.warn(`⚠️  Não foi possível remover: ${nome}`);
      }
    });

    await processarComLimite(tasks, concorrencia);

    // Restaura WAL após conclusão do grupo
    if (isGrande) {
      console.log(`\n🔒 Restaurando "${config.tabela}" para LOGGED...`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${config.tabela}" SET LOGGED`);
    }

    if (config.indexes.length > 0 && !indexesCriados.has(config.tabela)) {
      console.log(`\n🔧 Criando índices para "${config.tabela}"...`);
      for (const sql of config.indexes) {
        await prisma.$executeRawUnsafe(sql);
      }
      indexesCriados.add(config.tabela);
      console.log(`✅ Índices criados.`);
    }
  }

  console.log('\n🎉 Ingestão concluída com sucesso!');
  console.log('💡 Para reabilitar autovacuum: ALTER SYSTEM SET autovacuum=on; SELECT pg_reload_conf();');
}

main()
  .catch((err) => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
