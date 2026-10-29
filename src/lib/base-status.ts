import { prisma } from './prisma';
import { latestRunStatus } from '../ingest/state';

export interface BaseStatus {
  month: string | null;
  loadedAt: Date | null;
  maintenance: boolean;
}

export const MAINTENANCE_BODY = {
  error: 'Servidor em manutenção: atualização da base da Receita Federal em andamento.',
  code: 'maintenance',
} as const;

// ─── Status da base (cache em memória) ───────────────────────────────────────

const STATUS_TTL_MS = 30_000;
const EMPTY_STATUS: BaseStatus = { month: null, loadedAt: null, maintenance: false };

let cached: { value: BaseStatus; at: number } | null = null;
let inflight: Promise<BaseStatus> | null = null;

export function resetBaseStatusCache(): void {
  cached = null;
  inflight = null;
}

export async function getBaseStatus(): Promise<BaseStatus> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const value = await latestRunStatus(prisma);
      cached = { value, at: Date.now() };
      return value;
    } catch {
      // Banco indisponível: último valor conhecido (ou vazio) e não martela o banco por 30 s.
      const value = cached?.value ?? EMPTY_STATUS;
      cached = { value, at: Date.now() };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ─── Rotas que dependem dos dados da Receita ─────────────────────────────────

export function isReceitaRoute(url: string): boolean {
  const path = url.split('?')[0].split('#')[0];
  return (
    path === '/empresas' ||
    path.startsWith('/empresas/') ||
    path.startsWith('/cnpj/') ||
    path === '/consulta' ||
    path === '/consulta/exportar' ||
    path.startsWith('/cnaes/') ||
    path === '/municipios'
  );
}

// ─── Datas e aviso de cache defasado ─────────────────────────────────────────

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** dd/mm/aaaa no fuso America/Sao_Paulo. */
export function formatBaseDate(date: Date): string {
  return dateFormat.format(date);
}

export function cacheNotice(
  totalAt: Date,
  base: BaseStatus,
): { baseDesatualizada: boolean; aviso: string | null } {
  if (!base.loadedAt || totalAt >= base.loadedAt) {
    return { baseDesatualizada: false, aviso: null };
  }
  return {
    baseDesatualizada: true,
    aviso: `A base da Receita foi atualizada em ${formatBaseDate(base.loadedAt)} (mês ${base.month}). Os números desta consulta podem estar defasados.`,
  };
}
