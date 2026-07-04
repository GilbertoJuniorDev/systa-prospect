import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma';
import { SITUACAO_MAP, PORTE_MAP, formatCNPJ, formatCEP, formatFone, formatDate } from '../lib/formatters';
import { authenticate } from '../lib/authenticate';
import { deductCredits, addCredits } from '../lib/credits';

const MAX_EXPORT_ROWS = parseInt(process.env.MAX_EXPORT_ROWS ?? '200000', 10);

interface ConsultaBody {
  cnaes: string[];
  uf: string;
  municipios?: string[];
  situacao: 'ativa' | 'inativa' | 'todas';
  mei: 'sim' | 'nao' | 'todos';
}

type ConsultaRow = {
  cnpj_base: string;
  cnpj_ordem: string;
  cnpj_dv: string;
  identificador_matriz_filial: string | null;
  razao_social: string;
  nome_fantasia: string | null;
  cnae_fiscal_principal: string | null;
  cnae_descricao: string | null;
  cnae_fiscal_secundaria: string | null;
  situacao_cadastral: string | null;
  data_situacao_cadastral: string | null;
  data_inicio_atividade: string | null;
  uf: string | null;
  municipio_nome: string | null;
  tipo_logradouro: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cep: string | null;
  ddd1: string | null;
  telefone1: string | null;
  ddd2: string | null;
  telefone2: string | null;
  correio_eletronico: string | null;
  porte: string | null;
  capital_social: number | null;
  natureza_juridica: string | null;
  opcao_simples: string | null;
  opcao_mei: string | null;
  socios: string | null;
};

type CountRow = { total: number };

function buildConsultaWhere(body: ConsultaBody): Prisma.Sql {
  const situacaoClause =
    body.situacao === 'ativa'
      ? Prisma.sql`AND e.situacao_cadastral = '02'`
      : body.situacao === 'inativa'
        ? Prisma.sql`AND e.situacao_cadastral <> '02'`
        : Prisma.empty;

  const meiClause =
    body.mei === 'sim'
      ? Prisma.sql`AND s.opcao_mei = 'S'`
      : body.mei === 'nao'
        ? Prisma.sql`AND (s.opcao_mei IS NULL OR s.opcao_mei <> 'S')`
        : Prisma.empty;

  const municipioClause =
    body.municipios && body.municipios.length > 0
      ? Prisma.sql`AND e.municipio = ANY(${body.municipios})`
      : Prisma.empty;

  return Prisma.sql`
    WHERE e.cnae_fiscal_principal = ANY(${body.cnaes})
      AND e.uf = ${body.uf}
      ${municipioClause}
      ${situacaoClause}
      ${meiClause}
  `;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function buildParamsHash(body: ConsultaBody): string {
  const normalized = {
    cnaes: [...body.cnaes].sort(),
    uf: body.uf,
    municipios: body.municipios ? [...body.municipios].sort() : [],
    situacao: body.situacao,
    mei: body.mei,
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function validateBody(body: ConsultaBody): string | null {
  if (!Array.isArray(body.cnaes) || body.cnaes.length === 0) {
    return 'Campo "cnaes" deve conter ao menos um código CNAE.';
  }
  for (const c of body.cnaes) {
    if (!/^\d{7}$/.test(c)) return `CNAE inválido: "${c}". Deve conter 7 dígitos.`;
  }
  if (!body.uf || !/^[A-Z]{2}$/.test(body.uf)) {
    return 'Campo "uf" deve conter exatamente 2 letras maiúsculas.';
  }
  if (body.municipios) {
    for (const m of body.municipios) {
      if (!/^\d{4}$/.test(m)) return `Município inválido: "${m}". Deve conter 4 dígitos.`;
    }
  }
  if (!['ativa', 'inativa', 'todas'].includes(body.situacao)) {
    return 'Campo "situacao" deve ser "ativa", "inativa" ou "todas".';
  }
  if (!['sim', 'nao', 'todos'].includes(body.mei)) {
    return 'Campo "mei" deve ser "sim", "nao" ou "todos".';
  }
  return null;
}

export async function consultaRoutes(app: FastifyInstance) {
  // ─── GET /consultas/minhas ───────────────────────────────────────────────────
  app.get(
    '/consultas/minhas',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { userId } = request.user;
      const consultas = await prisma.consultaCache.findMany({
        where: { userId },
        select: { id: true, params: true, total: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return { consultas };
    },
  );

  // ─── GET /cnaes/buscar?q= ────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/cnaes/buscar', async (request, reply) => {
    const q = request.query.q?.trim() ?? '';

    if (q.length < 2) {
      return reply
        .status(400)
        .send({ error: 'Parâmetro "q" deve ter ao menos 2 caracteres.' });
    }

    const termo = `%${q}%`;
    const rows = await prisma.$queryRaw<{ codigo: string; descricao: string }[]>`
      SELECT codigo, descricao FROM "Cnae"
      WHERE descricao ILIKE ${termo}
         OR codigo ILIKE ${termo}
      ORDER BY descricao
      LIMIT 20
    `;

    return { dados: rows };
  });

  // ─── GET /municipios?uf= ─────────────────────────────────────────────────────
  app.get<{ Querystring: { uf?: string } }>('/municipios', async (request, reply) => {
    const uf = request.query.uf?.trim().toUpperCase() ?? '';

    if (!/^[A-Z]{2}$/.test(uf)) {
      return reply
        .status(400)
        .send({ error: 'Parâmetro "uf" deve conter exatamente 2 letras.' });
    }

    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
      return tx.$queryRaw<{ codigo: string; descricao: string }[]>`
        SELECT m.codigo, m.descricao
        FROM "Municipio" m
        WHERE EXISTS (
          SELECT 1 FROM "Estabelecimento" e
          WHERE e.uf = ${uf}
            AND e.municipio = m.codigo
          LIMIT 1
        )
        ORDER BY m.descricao
        LIMIT 500
      `;
    });

    return { uf, dados: rows };
  });

  // ─── POST /consulta ───────────────────────────────────────────────────────────
  app.post<{ Body: ConsultaBody }>(
    '/consulta',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const body = request.body;
    const err = validateBody(body);
    if (err) return reply.status(400).send({ error: err });

    const where = buildConsultaWhere(body);

    const countRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
      return tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS total
        FROM "Estabelecimento" e
        LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base
        ${where}
      `;
    });

    const total = countRows[0]?.total ?? 0;

    if (total > MAX_EXPORT_ROWS) {
      return reply.status(400).send({
        error: `A consulta retornou ${total.toLocaleString('pt-BR')} registros. Limite máximo é ${MAX_EXPORT_ROWS.toLocaleString('pt-BR')}. Refine os filtros para continuar.`,
        total,
      });
    }

    return { total };
    },
  );

  // ─── POST /consulta/exportar ──────────────────────────────────────────────────
  app.post<{ Body: ConsultaBody }>(
    '/consulta/exportar',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const body = request.body;
      const err = validateBody(body);
      if (err) return reply.status(400).send({ error: err });

      const where = buildConsultaWhere(body);

      // Guard: check total before exporting
      const countRows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
        return tx.$queryRaw<CountRow[]>`
          SELECT COUNT(*)::int AS total
          FROM "Estabelecimento" e
          LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base
          ${where}
        `;
      });
      const total = countRows[0]?.total ?? 0;

      if (total === 0) {
        return reply.status(404).send({ error: 'Nenhum registro encontrado para os filtros selecionados.' });
      }

      if (total > MAX_EXPORT_ROWS) {
        return reply.status(400).send({
          error: `A consulta retornou ${total.toLocaleString('pt-BR')} registros. Limite máximo para exportação é ${MAX_EXPORT_ROWS.toLocaleString('pt-BR')}. Refine os filtros.`,
          total,
        });
      }

      // Check cache: same user + same filters within 30 days = no credit charge
      const paramsHash = buildParamsHash(body);
      const now = new Date();
      const cached = await prisma.consultaCache.findUnique({
        where: { userId_paramsHash: { userId: request.user.userId, paramsHash } },
      });
      const isCached = cached !== null && cached.expiresAt > now;

      let exportCost = 0;
      if (!isCached) {
        exportCost = total;
        const credited = await deductCredits(
          request.user.userId,
          exportCost,
          'EXPORT',
          `Exportação de ${total.toLocaleString('pt-BR')} registros`,
          reply,
          paramsHash,
        );
        if (!credited) return;
      }

      let buffer: ArrayBuffer;
      try {
        const rows = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL work_mem = '32MB'`;
          return tx.$queryRaw<ConsultaRow[]>`
            SELECT
              e.cnpj_base, e.cnpj_ordem, e.cnpj_dv,
              e.identificador_matriz_filial,
              emp.razao_social, e.nome_fantasia,
              e.cnae_fiscal_principal,
              cn.descricao AS cnae_descricao,
              e.cnae_fiscal_secundaria,
              e.situacao_cadastral,
              e.data_situacao_cadastral,
              e.data_inicio_atividade,
              e.uf,
              m.descricao AS municipio_nome,
              e.tipo_logradouro, e.logradouro, e.numero, e.complemento,
              e.bairro, e.cep,
              e.ddd1, e.telefone1,
              e.ddd2, e.telefone2,
              e.correio_eletronico,
              emp.porte,
              emp.capital_social,
              nat.descricao AS natureza_juridica,
              s.opcao_simples,
              s.opcao_mei,
              (
                SELECT STRING_AGG(soc.nome_socio, ' | ' ORDER BY soc.nome_socio)
                FROM "Socio" soc
                WHERE soc.cnpj_base = e.cnpj_base
              ) AS socios
            FROM "Estabelecimento" e
            LEFT JOIN "Empresa" emp ON emp.cnpj_base = e.cnpj_base
            LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base
            LEFT JOIN "Municipio" m ON m.codigo = e.municipio
            LEFT JOIN "Cnae" cn ON cn.codigo = e.cnae_fiscal_principal
            LEFT JOIN "Natureza" nat ON nat.codigo = emp.natureza_juridica
            ${where}
            ORDER BY emp.razao_social
          `;
        });

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Systa';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet('Estabelecimentos');

        sheet.columns = [
          { header: 'CNPJ', key: 'cnpj', width: 22 },
          { header: 'Razão Social', key: 'razao_social', width: 42 },
          { header: 'Nome Fantasia', key: 'nome_fantasia', width: 32 },
          { header: 'Matriz/Filial', key: 'matriz_filial', width: 14 },
          { header: 'Situação', key: 'situacao', width: 14 },
          { header: 'Data Situação', key: 'data_situacao', width: 16 },
          { header: 'Data Início Atividade', key: 'data_inicio', width: 22 },
          { header: 'CNAE Principal', key: 'cnae', width: 16 },
          { header: 'Descrição CNAE', key: 'cnae_descricao', width: 46 },
          { header: 'CNAE Secundário', key: 'cnae_secundario', width: 32 },
          { header: 'MEI', key: 'mei', width: 8 },
          { header: 'Simples Nacional', key: 'simples', width: 18 },
          { header: 'Porte', key: 'porte', width: 24 },
          { header: 'Capital Social (R$)', key: 'capital_social', width: 22 },
          { header: 'Natureza Jurídica', key: 'natureza_juridica', width: 40 },
          { header: 'UF', key: 'uf', width: 6 },
          { header: 'Município', key: 'municipio', width: 28 },
          { header: 'Endereço', key: 'endereco', width: 50 },
          { header: 'Bairro', key: 'bairro', width: 22 },
          { header: 'CEP', key: 'cep', width: 12 },
          { header: 'Telefone 1', key: 'telefone1', width: 18 },
          { header: 'Telefone 2', key: 'telefone2', width: 18 },
          { header: 'E-mail', key: 'email', width: 36 },
          { header: 'Sócios', key: 'socios', width: 60 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF6D28D9' },
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 20;

        for (const r of rows) {
          const logradouro = [r.tipo_logradouro, r.logradouro, r.numero, r.complemento]
            .map((v) => v?.trim())
            .filter(Boolean)
            .join(', ');

          sheet.addRow({
            cnpj: formatCNPJ(r.cnpj_base, r.cnpj_ordem, r.cnpj_dv),
            razao_social: r.razao_social?.trim() ?? '',
            nome_fantasia: r.nome_fantasia?.trim() ?? '',
            matriz_filial: r.identificador_matriz_filial === '1' ? 'Matriz' : r.identificador_matriz_filial === '2' ? 'Filial' : '',
            situacao: SITUACAO_MAP[r.situacao_cadastral ?? ''] ?? r.situacao_cadastral ?? '',
            data_situacao: formatDate(r.data_situacao_cadastral) ?? '',
            data_inicio: formatDate(r.data_inicio_atividade) ?? '',
            cnae: r.cnae_fiscal_principal ?? '',
            cnae_descricao: r.cnae_descricao?.trim() ?? '',
            cnae_secundario: r.cnae_fiscal_secundaria?.trim() ?? '',
            mei: r.opcao_mei === 'S' ? 'Sim' : 'Não',
            simples: r.opcao_simples === 'S' ? 'Sim' : r.opcao_simples === 'N' ? 'Não' : '',
            porte: PORTE_MAP[r.porte ?? ''] ?? r.porte ?? '',
            capital_social: r.capital_social ?? 0,
            natureza_juridica: r.natureza_juridica?.trim() ?? '',
            uf: r.uf ?? '',
            municipio: r.municipio_nome ?? '',
            endereco: logradouro,
            bairro: r.bairro?.trim() ?? '',
            cep: formatCEP(r.cep) ?? '',
            telefone1: formatFone(r.ddd1, r.telefone1) ?? '',
            telefone2: formatFone(r.ddd2, r.telefone2) ?? '',
            email: r.correio_eletronico?.trim().toLowerCase() ?? '',
            socios: r.socios?.trim() ?? '',
          });
        }

        const capitalColIdx = sheet.columns.findIndex((c) => c.key === 'capital_social') + 1;
        if (capitalColIdx > 0) {
          sheet.getColumn(capitalColIdx).numFmt = '#,##0.00';
        }

        sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
        sheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: sheet.columns.length },
        };

        buffer = await workbook.xlsx.writeBuffer();
      } catch (err) {
        // Refund credits if the export failed after deduction
        if (!isCached && exportCost > 0) {
          await addCredits(
            request.user.userId,
            exportCost,
            'EXPORT_REFUND',
            `Reembolso automático por falha na exportação`,
          );
        }
        throw err;
      }

      // Save cache entry on first successful export with these filters
      if (!isCached) {
        const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
        await prisma.consultaCache.upsert({
          where: { userId_paramsHash: { userId: request.user.userId, paramsHash } },
          create: { userId: request.user.userId, paramsHash, params: body as unknown as Prisma.InputJsonValue, total, expiresAt },
          update: { total, expiresAt },
        });
      }

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="consulta_${new Date().toISOString().slice(0, 10)}.xlsx"`)
        .send(Buffer.from(buffer));
    },
  );
}
