export interface ExportPricing {
  cost: number;
  kind: 'full' | 'diff' | 'free';
}

/**
 * Preço da exportação: 1 crédito por registro. Sem cache válido: cobrança completa.
 * Com cache válido: cobra só os registros a mais desde o total salvo (base atualizada).
 */
export function exportPricing(total: number, cached: { total: number } | null): ExportPricing {
  if (cached === null) {
    return { cost: total, kind: 'full' };
  }
  const diff = total - cached.total;
  if (diff > 0) return { cost: diff, kind: 'diff' };
  return { cost: 0, kind: 'free' };
}
