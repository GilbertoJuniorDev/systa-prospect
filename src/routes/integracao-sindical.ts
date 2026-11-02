import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getBaseStatus } from '../lib/base-status';
import { MAX_EXPORT_ROWS, buildConsultaWhere, validateBody, type ConsultaBody } from './consulta';

// Rotas máquina-a-máquina para o systa-sindical. Além do x-internal-api-key (hook global
// em api.ts), exigem uma chave própria, para que a chave interna usada pelo frontend
// do prospect não dê acesso à base completa de empresas.

const MAX_CNPJS_POR_LOTE = 500;

interface ContagemBody {
  cnaes: string[];
  uf: string;
  municipios: string[];
  situacao: 'ativa' | 'todas';
}

interface EmpresasBody {
  cnpjs: string[];
}

type ContagemRow = { cnpj: string; municipio: string; municipio_nome: string | null };

type EmpresaRow = {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  data_inicio_atividade: string | null;
  capital_social: number | null;
  cnae_codigo: string | null;
  cnae_descricao: string | null;
  situacao_cadastral: string | null;
  tipo_logradouro: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cep: string | null;
  uf: string | null;
  municipio_nome: string | null;
  ddd1: string | null;
  telefone1: string | null;
  ddd2: string | null;
  telefone2: string | null;
  correio_eletronico: string | null;
};

// Compara hashes para que a comparação tenha tempo constante e tamanhos iguais.
function sindicalKeyMatches(received: unknown): boolean {
  const expected = process.env.SINDICAL_API_KEY;
  if (!expected || typeof received !== 'string') return false;
  const hash = (v: string) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(received), hash(expected));
}

async function requireSindicalKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!sindicalKeyMatches(request.headers['x-sindical-api-key'])) {
    await reply.code(401).send({ error: 'Unauthorized' });
  }
}

/** DDD + número só dígitos; telefone sem um dos dois não é utilizável. */
function telefoneDigitos(ddd: string | null, numero: string | null): string | null {
  const d = ddd?.replace(/\D/g, '') ?? '';
  const n = numero?.replace(/\D/g, '') ?? '';
  return d && n ? `${d}${n}` : null;
}

export async function integracaoSindicalRoutes(app: FastifyInstance) {
  // ─── POST /integracao/sindical/contagem ─────────────────────────────────────
  app.post<{ Body: ContagemBody }>(
    '/integracao/sindical/contagem',
    { preHandler: [requireSindicalKey] },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Corpo da requisição inválido.' });
      }
      if (body.situacao !== 'ativa' && body.situacao !== 'todas') {
        return reply.status(400).send({ error: 'Campo "situacao" deve ser "ativa" ou "todas".' });
      }

      // mei fixo em 'todos': a importação não filtra por MEI, então nem precisa do join com Simples.
      const consulta: ConsultaBody = {
        cnaes: body.cnaes,
        uf: body.uf,
        municipios: body.municipios,
        situacao: body.situacao,
        mei: 'todos',
      };
      const err = validateBody(consulta);
      if (err) return reply.status(400).send({ error: err });

      const where = buildConsultaWhere(consulta);

      const countRows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
        return tx.$queryRaw<{ total: number }[]>`
          SELECT COUNT(*)::int AS total
          FROM "Estabelecimento" e
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

      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
        return tx.$queryRaw<ContagemRow[]>`
          SELECT e.cnpj_base || e.cnpj_ordem || e.cnpj_dv AS cnpj,
                 e.municipio,
                 m.descricao AS municipio_nome
          FROM "Estabelecimento" e
          LEFT JOIN "Municipio" m ON m.codigo = e.municipio
          ${where}
        `;
      });

      const base = await getBaseStatus();
      return {
        baseMes: base.month,
        itens: rows.map((r) => ({
          cnpj: r.cnpj,
          municipio: r.municipio,
          municipioNome: r.municipio_nome,
        })),
      };
    },
  );

  // ─── POST /integracao/sindical/empresas ─────────────────────────────────────
  app.post<{ Body: EmpresasBody }>(
    '/integracao/sindical/empresas',
    { preHandler: [requireSindicalKey] },
    async (request, reply) => {
      const cnpjs = request.body?.cnpjs;
      if (!Array.isArray(cnpjs) || cnpjs.length < 1 || cnpjs.length > MAX_CNPJS_POR_LOTE) {
        return reply.status(400).send({ error: `Envie de 1 a ${MAX_CNPJS_POR_LOTE} CNPJs.` });
      }
      if (!cnpjs.every((c) => typeof c === 'string' && /^\d{14}$/.test(c))) {
        return reply.status(400).send({ error: 'Cada CNPJ deve conter exatamente 14 dígitos numéricos.' });
      }

      const unicos = [...new Set(cnpjs)];
      const bases = unicos.map((c) => c.slice(0, 8));
      const ordens = unicos.map((c) => c.slice(8, 12));
      const dvs = unicos.map((c) => c.slice(12, 14));

      const rows = await prisma.$queryRaw<EmpresaRow[]>(Prisma.sql`
        SELECT
          e.cnpj_base || e.cnpj_ordem || e.cnpj_dv AS cnpj,
          emp.razao_social,
          e.nome_fantasia,
          e.data_inicio_atividade,
          emp.capital_social,
          e.cnae_fiscal_principal AS cnae_codigo,
          cn.descricao AS cnae_descricao,
          e.situacao_cadastral,
          e.tipo_logradouro, e.logradouro, e.numero, e.complemento,
          e.bairro, e.cep, e.uf,
          m.descricao AS municipio_nome,
          e.ddd1, e.telefone1, e.ddd2, e.telefone2,
          e.correio_eletronico
        FROM "Estabelecimento" e
        JOIN "Empresa" emp ON emp.cnpj_base = e.cnpj_base
        LEFT JOIN "Municipio" m ON m.codigo = e.municipio
        LEFT JOIN "Cnae" cn ON cn.codigo = e.cnae_fiscal_principal
        WHERE (e.cnpj_base, e.cnpj_ordem, e.cnpj_dv) IN (
          SELECT * FROM unnest(${bases}::text[], ${ordens}::text[], ${dvs}::text[])
        )
      `);

      return {
        dados: rows.map((r) => ({
          cnpj: r.cnpj,
          razaoSocial: r.razao_social.trim(),
          nomeFantasia: r.nome_fantasia?.trim() || null,
          dataInicioAtividade: r.data_inicio_atividade,
          capitalSocial: r.capital_social,
          cnaeCodigo: r.cnae_codigo,
          cnaeDescricao: r.cnae_descricao,
          situacaoCadastral: r.situacao_cadastral,
          tipoLogradouro: r.tipo_logradouro,
          logradouro: r.logradouro,
          numero: r.numero,
          complemento: r.complemento,
          bairro: r.bairro,
          cep: r.cep,
          uf: r.uf,
          municipioNome: r.municipio_nome,
          telefones: [
            telefoneDigitos(r.ddd1, r.telefone1),
            telefoneDigitos(r.ddd2, r.telefone2),
          ].filter((t): t is string => t !== null),
          email: r.correio_eletronico?.trim().toLowerCase() || null,
        })),
      };
    },
  );
}
