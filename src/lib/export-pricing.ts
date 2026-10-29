export interface ExportPricing {
  cost: number;
  kind: 'full' | 'diff' | 'free';
}

/**
 * Preço da exportação. Sem cache válido: cobrança completa (mín. 1 crédito).
 * Com cache válido: cobra só o crescimento desde o total salvo (base atualizada).
 */
export function exportPricing(total: number, cached: { total: number } | null): ExportPricing {
  if (cached === null) {
    return { cost: Math.max(1, Math.ceil(total / 10)), kind: 'full' };
  }
  const diff = total - cached.total;
  if (diff > 0) return { cost: Math.ceil(diff / 10), kind: 'diff' };
  return { cost: 0, kind: 'free' };
}
