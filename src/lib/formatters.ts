export const SITUACAO_MAP: Record<string, string> = {
  '01': 'Nula',
  '02': 'Ativa',
  '03': 'Suspensa',
  '04': 'Inapta',
  '08': 'Baixada',
};

export const PORTE_MAP: Record<string, string> = {
  '00': 'Não Informado',
  '01': 'Micro Empresa',
  '03': 'Empresa de Pequeno Porte',
  '05': 'Demais',
};

export function formatDate(raw: string | null): string | null {
  if (!raw || raw.replace(/\D/g, '').length !== 8) return null;
  const d = raw.replace(/\D/g, '');
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
}

export function formatFone(ddd: string | null, numero: string | null): string | null {
  if (!ddd?.trim() || !numero?.trim()) return null;
  return `(${ddd.trim()}) ${numero.trim()}`;
}

export function formatCNPJ(base: string, ordem: string, dv: string): string {
  const raw =
    base.padStart(8, '0') + ordem.padStart(4, '0') + dv.padStart(2, '0');
  return raw.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5',
  );
}

export function formatCEP(cep: string | null): string | null {
  if (!cep) return null;
  const digits = cep.replace(/\D/g, '');
  if (digits.length !== 8) return cep;
  return digits.replace(/^(\d{5})(\d{3})$/, '$1-$2');
}
