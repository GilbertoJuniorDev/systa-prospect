import { describe, it, expect } from 'vitest';
import {
  CONFIGS,
  RECEITA_TABLES,
  SECONDARY_INDEXES,
  TABLE_ORDER,
  configForCsv,
  zipTable,
} from '../../src/ingest/tables';

describe('zipTable', () => {
  it('mapeia o prefixo do ZIP para a tabela', () => {
    expect(zipTable('Empresas0.zip')).toBe('Empresa');
    expect(zipTable('ESTABELECIMENTOS9.ZIP')).toBe('Estabelecimento');
    expect(zipTable('Simples.zip')).toBe('Simples');
    expect(zipTable('Qualificacoes.zip')).toBe('Qualificacao');
    expect(zipTable('Socios3.zip')).toBe('Socio');
    expect(zipTable('Cnaes.zip')).toBe('Cnae');
    expect(zipTable('Motivos.zip')).toBe('Motivo');
    expect(zipTable('Municipios.zip')).toBe('Municipio');
    expect(zipTable('Naturezas.zip')).toBe('Natureza');
    expect(zipTable('Paises.zip')).toBe('Pais');
  });

  it('retorna null para não-zip ou prefixo desconhecido', () => {
    expect(zipTable('LAYOUT.pdf')).toBeNull();
    expect(zipTable('Novidade.zip')).toBeNull();
  });
});

describe('configForCsv', () => {
  it('resolve pela extensão', () => {
    expect(configForCsv('K3241.K03200Y0.D30513.EMPRECSV')?.tabela).toBe('Empresa');
    expect(configForCsv('K3241.K03200Y0.D30513.ESTABELE')?.tabela).toBe('Estabelecimento');
    expect(configForCsv('K3241.K03200Y0.D30513.SOCIOCSV')?.tabela).toBe('Socio');
  });

  it('resolve Simples por nameContains', () => {
    expect(configForCsv('F.K03200$W.SIMPLES.CSV.D30513')?.tabela).toBe('Simples');
  });

  it('retorna null para arquivo desconhecido', () => {
    expect(configForCsv('LAYOUT.pdf')).toBeNull();
  });
});

describe('tabelas e índices', () => {
  it('TABLE_ORDER segue a ordem de grupos e RECEITA_TABLES é o mesmo', () => {
    expect(TABLE_ORDER).toEqual([
      'Cnae', 'Motivo', 'Municipio', 'Natureza', 'Pais', 'Qualificacao',
      'Empresa', 'Simples', 'Estabelecimento', 'Socio',
    ]);
    expect(RECEITA_TABLES).toBe(TABLE_ORDER);
  });

  it('todas as tabelas de CONFIGS estão em TABLE_ORDER', () => {
    expect(Object.values(CONFIGS).map((c) => c.tabela).sort()).toEqual([...TABLE_ORDER].sort());
  });

  it('Socio não tem conflito; as demais usam ON CONFLICT DO NOTHING', () => {
    for (const config of Object.values(CONFIGS)) {
      if (config.tabela === 'Socio') expect(config.conflito).toBeNull();
      else expect(config.conflito).toMatch(/ON CONFLICT .* DO NOTHING/);
    }
  });

  it('SECONDARY_INDEXES', () => {
    expect(SECONDARY_INDEXES.Empresa.map((i) => i.name)).toEqual(['idx_razao_social_trgm']);
    expect(SECONDARY_INDEXES.Estabelecimento.map((i) => i.name)).toEqual([
      'idx_estab_cnpj_base', 'idx_estab_uf', 'idx_estab_cnae',
      'Estabelecimento_uf_municipio_idx', 'Estabelecimento_uf_cnae_idx',
      'Estabelecimento_uf_data_inicio_atividade_idx',
    ]);
    expect(SECONDARY_INDEXES.Socio.map((i) => i.name)).toEqual(['idx_socio_cnpj_base', 'idx_socio_cpf']);
    for (const idx of Object.values(SECONDARY_INDEXES).flat()) {
      expect(idx.sql).toContain(idx.name);
    }
  });
});
