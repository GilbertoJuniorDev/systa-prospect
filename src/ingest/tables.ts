// ─── Mapeamento de arquivos e tabelas da Receita ────────────────────────────

function col(row: Record<number, string>, idx: number): string {
  return (row[idx] ?? '').trim();
}

function colOpt(row: Record<number, string>, idx: number): string | null {
  const v = (row[idx] ?? '').trim();
  return v === '' ? null : v;
}

// ─── Configuração por tipo de arquivo ────────────────────────────────────────

export interface TabelaConfig {
  tabela: string;
  nameContains?: string;
  stagingDDL: string;
  copyColunas: string[];
  parseRow: (row: Record<number, string>) => (string | null)[];
  conflito: string | null;
}

export const CONFIGS: Record<string, TabelaConfig> = {
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
  },
};

// ─── Ordem e mapeamento ──────────────────────────────────────────────────────

export const TABLE_ORDER: string[] = [
  'Cnae', 'Motivo', 'Municipio', 'Natureza', 'Pais', 'Qualificacao',
  'Empresa', 'Simples', 'Estabelecimento', 'Socio',
];

export const RECEITA_TABLES: string[] = TABLE_ORDER;

const ZIP_PREFIX_TO_TABLE: Record<string, string> = {
  cnaes: 'Cnae',
  motivos: 'Motivo',
  municipios: 'Municipio',
  naturezas: 'Natureza',
  paises: 'Pais',
  qualificacoes: 'Qualificacao',
  empresas: 'Empresa',
  simples: 'Simples',
  estabelecimentos: 'Estabelecimento',
  socios: 'Socio',
};

/** Tabela de destino de um ZIP da Receita (ex.: Empresas0.zip → Empresa). */
export function zipTable(fileName: string): string | null {
  const match = /^([a-z]+)\d*\.zip$/i.exec(fileName);
  if (!match) return null;
  return ZIP_PREFIX_TO_TABLE[match[1].toLowerCase()] ?? null;
}

/** Mesma regra de listarPorExtensao: nameContains ou sufixo da extensão. */
export function configForCsv(fileName: string): TabelaConfig | null {
  const upper = fileName.toUpperCase();
  for (const [extensao, config] of Object.entries(CONFIGS)) {
    const matches = config.nameContains
      ? upper.includes(config.nameContains.toUpperCase())
      : upper.endsWith(extensao.toUpperCase());
    if (matches) return config;
  }
  return null;
}

// ─── Índices secundários (criados após a carga) ──────────────────────────────

export const SECONDARY_INDEXES: Record<string, { name: string; sql: string }[]> = {
  Empresa: [
    {
      name: 'idx_razao_social_trgm',
      sql: `CREATE INDEX IF NOT EXISTS idx_razao_social_trgm ON "Empresa" USING gin (razao_social gin_trgm_ops)`,
    },
  ],
  Estabelecimento: [
    {
      name: 'idx_estab_cnpj_base',
      sql: `CREATE INDEX IF NOT EXISTS idx_estab_cnpj_base ON "Estabelecimento" (cnpj_base)`,
    },
    {
      name: 'idx_estab_uf',
      sql: `CREATE INDEX IF NOT EXISTS idx_estab_uf ON "Estabelecimento" (uf)`,
    },
    {
      name: 'idx_estab_cnae',
      sql: `CREATE INDEX IF NOT EXISTS idx_estab_cnae ON "Estabelecimento" (cnae_fiscal_principal)`,
    },
    {
      name: 'Estabelecimento_uf_municipio_idx',
      sql: `CREATE INDEX IF NOT EXISTS "Estabelecimento_uf_municipio_idx" ON "Estabelecimento" ("uf", "municipio")`,
    },
    {
      name: 'Estabelecimento_uf_cnae_idx',
      sql: `CREATE INDEX IF NOT EXISTS "Estabelecimento_uf_cnae_idx" ON "Estabelecimento" ("uf", "cnae_fiscal_principal")`,
    },
  ],
  Socio: [
    {
      name: 'idx_socio_cnpj_base',
      sql: `CREATE INDEX IF NOT EXISTS idx_socio_cnpj_base ON "Socio" (cnpj_base)`,
    },
    {
      name: 'idx_socio_cpf',
      sql: `CREATE INDEX IF NOT EXISTS idx_socio_cpf ON "Socio" (cnpj_cpf_socio)`,
    },
  ],
};
