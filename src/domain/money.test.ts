import { describe, expect, it } from 'vitest';
import { formatBRL, formatPriceInput, hasPublicPrice, parseBRL } from './money';

describe('parseBRL (centavos)', () => {
  it.each([
    ['49,90', 4990],
    ['189,99', 18999],
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['R$ 1.234,56', 123456],
    ['r$1.234,5', 123450],
    ['12.345.678,90', 1234567890],
    ['49.90', 4990],
    ['49.9', 4990],
    ['1.234', 123400],
    ['0,01', 1],
    ['3,49', 349],
    ['  27,90  ', 2790],
    ['10', 1000],
  ])('"%s" → %i', (input, cents) => {
    expect(parseBRL(input)).toBe(cents);
  });

  it.each(['12,345', '1,234,56', '12.34,5', 'abc', '-5,00', '1.23.456,00', '12,', ',50', '1e3'])('rejeita "%s"', (input) => {
    expect(parseBRL(input)).toBeNaN();
  });

  it('vazio ou nulo → null (sem preço)', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('   ')).toBeNull();
    expect(parseBRL(null)).toBeNull();
    expect(parseBRL(undefined)).toBeNull();
  });

  it('não sofre erro de ponto flutuante', () => {
    // 0,29 * 100 em float = 28.999999999999996
    expect(parseBRL('0,29')).toBe(29);
    expect(parseBRL('1.005,15')).toBe(100515);
  });
});

describe('formatação', () => {
  it('exibe em reais', () => {
    expect(formatBRL(123456).replace(/\s/g, ' ')).toBe('R$ 1.234,56');
    expect(formatBRL(349).replace(/\s/g, ' ')).toBe('R$ 3,49');
  });
  it('campo de edição faz ida e volta sem perder centavos', () => {
    expect(formatPriceInput(123456)).toBe('1.234,56');
    expect(formatPriceInput(null)).toBe('');
    for (const c of [1, 99, 4990, 123456, 1234567890]) expect(parseBRL(formatPriceInput(c))).toBe(c);
  });
  it('preço público exige exibir + valor positivo', () => {
    expect(hasPublicPrice({ showPrice: true, priceCents: 100 })).toBe(true);
    expect(hasPublicPrice({ showPrice: false, priceCents: 100 })).toBe(false);
    expect(hasPublicPrice({ showPrice: true, priceCents: null })).toBe(false);
    expect(hasPublicPrice({ showPrice: true, priceCents: 0 })).toBe(false);
  });
});
