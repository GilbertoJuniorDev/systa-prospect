import { describe, it, expect } from 'vitest';
import { CNAE_DIVISOES, CODIGOS_DIVISAO } from '../../src/lib/cnae-divisoes';

describe('CNAE_DIVISOES', () => {
  it('tem as 87 divisões da CNAE 2.3', () => {
    expect(CNAE_DIVISOES).toHaveLength(87);
  });

  it('códigos únicos de 2 dígitos', () => {
    const codigos = CNAE_DIVISOES.map((d) => d.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of codigos) expect(c).toMatch(/^\d{2}$/);
  });

  it('contém divisões conhecidas com o nome oficial', () => {
    expect(CNAE_DIVISOES).toContainEqual({ codigo: '47', descricao: 'Comércio varejista' });
    expect(CNAE_DIVISOES).toContainEqual({
      codigo: '01',
      descricao: 'Agricultura, pecuária e serviços relacionados',
    });
    expect(CNAE_DIVISOES).toContainEqual({ codigo: '56', descricao: 'Alimentação' });
  });

  it('CODIGOS_DIVISAO só tem códigos existentes', () => {
    expect(CODIGOS_DIVISAO.has('47')).toBe(true);
    expect(CODIGOS_DIVISAO.has('04')).toBe(false);
    expect(CODIGOS_DIVISAO.size).toBe(87);
  });
});
