import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getBaseStatus } from '../lib/base-status';
import { CNAE_DIVISOES, CODIGOS_DIVISAO } from '../lib/cnae-divisoes';
import { MAX_EXPORT_ROWS, buildConsultaWhere, validateBody, type ConsultaBody } from './consulta';

// Rotas máquina-a-máquina para o systa-sindical. Além do x-internal-api-key (hook global
// em api.ts), exigem uma chave própria, para que a chave interna usada pelo frontend
// do prospect não dê acesso à base completa de empresas.

const MAX_CNPJS_POR_LOTE = 500;

type MeiFiltro = ConsultaBody['mei'];

interface ContagemBody {
  cnaes?: string[];
  divisoes?: string[];
  uf: string;
  municipios: string[];
  situacao: 'ativa' | 'todas';
  mei?: MeiFiltro;
}

// Só serve para validateBody aceitar a consulta quando ela vem apenas com divisões:
// os CNAEs reais são resolvidos depois, no banco.
const CNAE_PLACEHOLDER = '0000000';

/** Valida `divisoes` (2 dígitos, existentes na CNAE 2.3, sem repetição). Retorna a mensagem de erro, se houver. */
function validateDivisoes(divisoes: unknown): string | null {
  if (!Array.isArray(divisoes)) return 'Campo "divisoes" deve ser uma lista de códigos de divisão.';
  const vistas = new Set<string>();
  for (const d of divisoes) {
    if (typeof d !== 'string' || !/^\d{2}$/.test(d) || !CODIGOS_DIVISAO.has(d)) {
      return `Divisão inválida: "${String(d)}". Deve ser um código de 2 dígitos da CNAE.`;
    }
    if (vistas.has(d)) return `Divisão repetida: "${d}".`;
    vistas.add(d);
  }
  return null;
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

      const mei: MeiFiltro = body.mei ?? 'todos';
      const divisoes = body.divisoes ?? [];
      const divisoesErr = validateDivisoes(divisoes);
      if (divisoesErr) return reply.status(400).send({ error: divisoesErr });

      const cnaesAvulsos = body.cnaes ?? [];
      if (!Array.isArray(cnaesAvulsos)) {
        return reply.status(400).send({ error: 'Campo "cnaes" deve conter ao menos um código CNAE.' });
      }
      if (cnaesAvulsos.length === 0 && divisoes.length === 0) {
        return reply.status(400).send({ error: 'Informe ao menos um CNAE ou uma divisão.' });
      }

      // Valida tudo antes de tocar no banco; com só divisões, o placeholder satisfaz a regra "ao menos um CNAE".
      const err = validateBody({
        cnaes: cnaesAvulsos.length > 0 ? cnaesAvulsos : [CNAE_PLACEHOLDER],
        uf: body.uf,
        municipios: body.municipios,
        situacao: body.situacao,
        mei,
      });
      if (err) return reply.status(400).send({ error: err });

      // Eco dos filtros efetivamente aplicados, para o chamador gravar na consulta.
      const filtros = { divisoes: [...divisoes].sort(), mei };
      const base = await getBaseStatus();

      // A divisão é o prefixo de 2 dígitos do CNAE principal; expande para as subclasses existentes.
      let cnaes = [...new Set(cnaesAvulsos)];
      if (divisoes.length > 0) {
        const expandidos = await prisma.$queryRaw<{ codigo: string }[]>`
          SELECT codigo FROM "Cnae" WHERE left(codigo, 2) = ANY(${divisoes})
        `;
        cnaes = [...new Set([...cnaes, ...expandidos.map((r) => r.codigo)])];
      }
      // Divisão sem nenhuma subclasse na base: nada a contar.
      if (cnaes.length === 0) {
        return { baseMes: base.month, itens: [], filtros };
      }

      const consulta: ConsultaBody = {
        cnaes,
        uf: body.uf,
        municipios: body.municipios,
        situacao: body.situacao,
        mei,
      };
      const where = buildConsultaWhere(consulta);
      // O filtro de MEI referencia o alias "s"; sem filtro, o join com Simples é custo à toa.
      const simplesJoin =
        mei === 'todos' ? Prisma.empty : Prisma.sql`LEFT JOIN "Simples" s ON s.cnpj_base = e.cnpj_base`;

      const countRows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
        return tx.$queryRaw<{ total: number }[]>`
          SELECT COUNT(*)::int AS total
          FROM "Estabelecimento" e
          ${simplesJoin}
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
          ${simplesJoin}
          ${where}
        `;
      });

      return {
        baseMes: base.month,
        itens: rows.map((r) => ({
          cnpj: r.cnpj,
          municipio: r.municipio,
          municipioNome: r.municipio_nome,
        })),
        filtros,
      };
    },
  );

  // ─── GET /integracao/sindical/cnae-divisoes ─────────────────────────────────
  // Divisões CNAE (2 dígitos) que têm ao menos uma atividade na tabela "Cnae", com a
  // contagem de atividades. Uma única agregação; os nomes vêm da lista estática.
  app.get('/integracao/sindical/cnae-divisoes', { preHandler: [requireSindicalKey] }, async () => {
    const rows = await prisma.$queryRaw<{ divisao: string; atividades: number }[]>`
      SELECT left(codigo, 2) AS divisao, COUNT(*)::int AS atividades
      FROM "Cnae"
      GROUP BY left(codigo, 2)
    `;
    const atividadesPorDivisao = new Map(rows.map((r) => [r.divisao, r.atividades]));

    return {
      dados: CNAE_DIVISOES.flatMap((d) => {
        const atividades = atividadesPorDivisao.get(d.codigo) ?? 0;
        return atividades > 0 ? [{ codigo: d.codigo, descricao: d.descricao, atividades }] : [];
      }),
    };
  });

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
