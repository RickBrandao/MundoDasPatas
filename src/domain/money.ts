import type { Cents } from './types';

/**
 * Converte um valor digitado no padrão brasileiro para centavos inteiros.
 *
 * - Vírgula é o separador decimal; ponto agrupa milhares em blocos de 3.
 * - Sem vírgula, "49.90" (1–2 casas) é decimal e "1.234" é milhar.
 * - Retorna `null` para entrada vazia e `NaN` para entrada inválida.
 *
 * A conversão é feita sobre o texto (sem aritmética de ponto flutuante).
 */
export function parseBRL(input: unknown): Cents | null {
  const s = String(input ?? '')
    .replace(/R\$/gi, '')
    .replace(/\s/g, '');
  if (!s) return null;

  let intPart: string;
  let fracPart = '';
  if (s.includes(',')) {
    if (!/^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(s)) return NaN;
    [intPart, fracPart] = s.split(',');
    intPart = intPart.replace(/\./g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    intPart = s.replace(/\./g, '');
  } else if (/^\d+(\.\d{1,2})?$/.test(s)) {
    [intPart, fracPart = ''] = s.split('.');
  } else {
    return NaN;
  }

  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : NaN;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 → "R$ 1.234,56" (com espaço não separável, como o Intl produz). */
export function formatBRL(cents: Cents): string {
  return currency.format(cents / 100);
}

/** Valor para o campo de edição: 123456 → "1.234,56"; null → "". */
export function formatPriceInput(cents: Cents | null): string {
  return cents == null ? '' : decimal.format(cents / 100);
}

/** O produto exibe preço ao cliente? */
export function hasPublicPrice(p: { showPrice: boolean; priceCents: Cents | null }): boolean {
  return p.showPrice && p.priceCents != null && p.priceCents > 0;
}
