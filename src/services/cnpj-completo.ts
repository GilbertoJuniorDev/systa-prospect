import { prisma } from '../lib/prisma';
import { SITUACAO_MAP, formatFone, formatCNPJ, formatCEP } from '../lib/formatters';

/**
 * Ficha completa de um estabelecimento (dados, CNAEs, endereço, Simples e QSA). Compartilhada
 * por `GET /cnpj/:cnpj` (usuário do prospect) e pela rota de integração do sindical, para as duas
 * montarem exatamente os mesmos dados.
 *
 * @param cnpj 14 dígitos numéricos, já validados pelo chamador.
 * @returns `null` quando o CNPJ não está na base.
 */
export async function buscarCnpjCompleto(cnpj: string) {
  const cnpj_base  = cnpj.slice(0, 8);
  const cnpj_ordem = cnpj.slice(8, 12);
  const cnpj_dv    = cnpj.slice(12, 14);

  type FullRow = {
    cnpj_base: string;
    cnpj_ordem: string;
    cnpj_dv: string;
    identificador_matriz_filial: string | null;
    nome_fantasia: string | null;
    situacao_cadastral: string | null;
    data_situacao_cadastral: string | null;
    motivo_situacao_cadastral: string | null;
    motivo_descricao: string | null;
    nome_cidade_exterior: string | null;
    pais_codigo: string | null;
    pais_descricao: string | null;
    data_inicio_atividade: string | null;
    cnae_fiscal_principal: string | null;
    cnae_principal_descricao: string | null;
    cnae_fiscal_secundaria: string | null;
    tipo_logradouro: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cep: string | null;
    uf: string | null;
    municipio_codigo: string | null;
    municipio_nome: string | null;
    ddd1: string | null;
    telefone1: string | null;
    ddd2: string | null;
    telefone2: string | null;
    ddd_fax: string | null;
    fax: string | null;
    correio_eletronico: string | null;
    situacao_especial: string | null;
    data_situacao_especial: string | null;
    razao_social: string;
    natureza_juridica: string | null;
    natureza_descricao: string | null;
    qualificacao_resp: string | null;
    qualificacao_resp_descricao: string | null;
    capital_social: number | null;
    porte: string | null;
    ente_federativo: string | null;
    opcao_simples: string | null;
    data_opcao_simples: string | null;
    data_exclusao_simples: string | null;
    opcao_mei: string | null;
    data_opcao_mei: string | null;
    data_exclusao_mei: string | null;
  };

  type SocioRow = {
    identificador_socio: string;
    nome_socio: string | null;
    cnpj_cpf_socio: string | null;
    qualificacao_socio: string | null;
    qualificacao_socio_descricao: string | null;
    data_entrada_sociedade: string | null;
    pais: string | null;
    pais_descricao: string | null;
    representante_legal: string | null;
    nome_representante: string | null;
    qualificacao_representante: string | null;
    qualificacao_representante_descricao: string | null;
    faixa_etaria: string | null;
  };

  const [rows, socios] = await Promise.all([
    prisma.$queryRaw<FullRow[]>`
      SELECT
        e.cnpj_base, e.cnpj_ordem, e.cnpj_dv,
        e.identificador_matriz_filial,
        e.nome_fantasia,
        e.situacao_cadastral,
        e.data_situacao_cadastral,
        e.motivo_situacao_cadastral,
        mot.descricao   AS motivo_descricao,
        e.nome_cidade_exterior,
        e.pais          AS pais_codigo,
        ps.descricao    AS pais_descricao,
        e.data_inicio_atividade,
        e.cnae_fiscal_principal,
        cn.descricao    AS cnae_principal_descricao,
        e.cnae_fiscal_secundaria,
        e.tipo_logradouro, e.logradouro, e.numero, e.complemento,
        e.bairro, e.cep, e.uf,
        e.municipio     AS municipio_codigo,
        m.descricao     AS municipio_nome,
        e.ddd1, e.telefone1, e.ddd2, e.telefone2, e.ddd_fax, e.fax,
        e.correio_eletronico,
        e.situacao_especial, e.data_situacao_especial,
        emp.razao_social,
        emp.natureza_juridica,
        nat.descricao   AS natureza_descricao,
        emp.qualificacao_resp,
        qr.descricao    AS qualificacao_resp_descricao,
        emp.capital_social, emp.porte, emp.ente_federativo,
        s.opcao_simples, s.data_opcao_simples, s.data_exclusao_simples,
        s.opcao_mei,    s.data_opcao_mei,    s.data_exclusao_mei
      FROM "Estabelecimento" e
      JOIN  "Empresa"      emp ON emp.cnpj_base = e.cnpj_base
      LEFT JOIN "Municipio"    m   ON m.codigo   = e.municipio
      LEFT JOIN "Motivo"       mot ON mot.codigo = e.motivo_situacao_cadastral
      LEFT JOIN "Pais"         ps  ON ps.codigo  = e.pais
      LEFT JOIN "Cnae"         cn  ON cn.codigo  = e.cnae_fiscal_principal
      LEFT JOIN "Natureza"     nat ON nat.codigo = emp.natureza_juridica
      LEFT JOIN "Qualificacao" qr  ON qr.codigo  = emp.qualificacao_resp
      LEFT JOIN "Simples"      s   ON s.cnpj_base = e.cnpj_base
      WHERE e.cnpj_base  = ${cnpj_base}
        AND e.cnpj_ordem = ${cnpj_ordem}
        AND e.cnpj_dv    = ${cnpj_dv}
    `,
    prisma.$queryRaw<SocioRow[]>`
      SELECT
        sc.identificador_socio, sc.nome_socio, sc.cnpj_cpf_socio,
        sc.qualificacao_socio,
        qs.descricao  AS qualificacao_socio_descricao,
        sc.data_entrada_sociedade,
        sc.pais,
        ps.descricao  AS pais_descricao,
        sc.representante_legal, sc.nome_representante,
        sc.qualificacao_representante,
        qr.descricao  AS qualificacao_representante_descricao,
        sc.faixa_etaria
      FROM "Socio" sc
      LEFT JOIN "Qualificacao" qs ON qs.codigo = sc.qualificacao_socio
      LEFT JOIN "Pais"         ps ON ps.codigo = sc.pais
      LEFT JOIN "Qualificacao" qr ON qr.codigo = sc.qualificacao_representante
      WHERE sc.cnpj_base = ${cnpj_base}
      ORDER BY sc.nome_socio
    `,
  ]);

  if (rows.length === 0) return null;

  const r = rows[0];

  const codigosSecundarios: string[] = r.cnae_fiscal_secundaria
    ? r.cnae_fiscal_secundaria.split(',').map((c: string) => c.trim()).filter((c: string) => /^\d{7}$/.test(c))
    : [];

  const cnaesSecundarios = codigosSecundarios.length > 0
    ? await prisma.$queryRaw<{ codigo: string; descricao: string }[]>`
        SELECT codigo, descricao FROM "Cnae"
        WHERE codigo = ANY(${codigosSecundarios})
        ORDER BY codigo
      `
    : [];

  return {
    cnpj: formatCNPJ(r.cnpj_base, r.cnpj_ordem, r.cnpj_dv),
    cnpj_base: r.cnpj_base,
    identificacao: {
      razao_social: r.razao_social.trim(),
      nome_fantasia: r.nome_fantasia?.trim() ?? null,
      tipo: r.identificador_matriz_filial === '1' ? 'Matriz' : 'Filial',
    },
    situacao_cadastral: {
      codigo: r.situacao_cadastral ?? null,
      descricao: SITUACAO_MAP[r.situacao_cadastral ?? ''] ?? r.situacao_cadastral ?? null,
      data: r.data_situacao_cadastral ?? null,
      motivo_codigo: r.motivo_situacao_cadastral ?? null,
      motivo_descricao: r.motivo_descricao ?? null,
    },
    empresa: {
      natureza_juridica: r.natureza_juridica ?? null,
      natureza_descricao: r.natureza_descricao ?? null,
      porte: r.porte ?? null,
      capital_social: r.capital_social ?? null,
      qualificacao_resp: r.qualificacao_resp ?? null,
      qualificacao_resp_descricao: r.qualificacao_resp_descricao ?? null,
      ente_federativo: r.ente_federativo ?? null,
    },
    atividade: {
      data_inicio_atividade: r.data_inicio_atividade ?? null,
      situacao_especial: r.situacao_especial ?? null,
      data_situacao_especial: r.data_situacao_especial ?? null,
      pais_codigo: r.pais_codigo ?? null,
      pais_descricao: r.pais_descricao ?? null,
      nome_cidade_exterior: r.nome_cidade_exterior ?? null,
    },
    cnae: {
      principal: r.cnae_fiscal_principal
        ? { codigo: r.cnae_fiscal_principal, descricao: r.cnae_principal_descricao ?? null }
        : null,
      secundarios: cnaesSecundarios,
    },
    endereco: {
      tipo_logradouro: r.tipo_logradouro ?? null,
      logradouro: r.logradouro ?? null,
      numero: r.numero ?? null,
      complemento: r.complemento ?? null,
      bairro: r.bairro ?? null,
      cep: formatCEP(r.cep),
      municipio_codigo: r.municipio_codigo ?? null,
      municipio: r.municipio_nome ?? null,
      uf: r.uf ?? null,
    },
    contato: {
      telefone1: formatFone(r.ddd1, r.telefone1),
      telefone2: formatFone(r.ddd2, r.telefone2),
      fax: formatFone(r.ddd_fax, r.fax),
      emails: r.correio_eletronico
        ? r.correio_eletronico.split(/[,/]/).map((e: string) => e.trim()).filter(Boolean)
        : [],
    },
    simples: {
      opcao_simples: r.opcao_simples ?? null,
      data_opcao_simples: r.data_opcao_simples ?? null,
      data_exclusao_simples: r.data_exclusao_simples ?? null,
      opcao_mei: r.opcao_mei ?? null,
      data_opcao_mei: r.data_opcao_mei ?? null,
      data_exclusao_mei: r.data_exclusao_mei ?? null,
    },
    socios: socios.map((s: SocioRow) => ({
      identificador_socio: s.identificador_socio,
      nome_socio: s.nome_socio ?? null,
      cnpj_cpf_socio: s.cnpj_cpf_socio ?? null,
      qualificacao_socio: s.qualificacao_socio_descricao ?? null,
      data_entrada_sociedade: s.data_entrada_sociedade ?? null,
      pais: s.pais_descricao ?? null,
      nome_representante: s.nome_representante ?? null,
      qualificacao_representante: s.qualificacao_representante_descricao ?? null,
      faixa_etaria: s.faixa_etaria ?? null,
    })),
  };
}
