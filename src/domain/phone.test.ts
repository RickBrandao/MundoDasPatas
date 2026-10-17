import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';
import { buildOrderMessage, buildWhatsAppLink, openWhatsApp } from './whatsapp';

const e164 = (s: string) => {
  const r = normalizePhone(s);
  return r.ok ? r.e164 : r.error;
};

describe('normalizePhone', () => {
  it.each([
    ['(11) 98888-7777', '5511988887777'],
    ['+55 11 98888-7777', '5511988887777'],
    ['+55 (11) 98888-7777', '5511988887777'],
    ['5511988887777', '5511988887777'],
    ['011 98888-7777', '5511988887777'],
    ['(55) 99999-8888', '5555999998888'], // DDD 55 (RS) não é confundido com o código do país
    ['(11) 3333-4444', '551133334444'],
    ['11.3333.4444', '551133334444'],
    ['(11) 90000-0000', '5511900000000'],
  ])('"%s" → %s', (input, expected) => {
    expect(e164(input)).toBe(expected);
  });

  it.each([
    ['', 'Informe o WhatsApp com DDD.'],
    ['123', 'Informe DDD + número (10 ou 11 dígitos).'],
    ['+1 415 555 0100', 'Somente números do Brasil (+55) com DDD são aceitos.'],
    ['(11) 88888-7777', 'Celular com 11 dígitos deve ter 9 após o DDD.'],
    ['(10) 98888-7777', 'DDD inválido.'],
    ['11 9888a-7777', 'Use apenas números, espaços, parênteses, hífen e +.'],
  ])('rejeita "%s"', (input, error) => {
    expect(normalizePhone(input)).toEqual({ ok: false, error });
  });
});

describe('WhatsApp', () => {
  it('mensagem lista itens e quantidades', () => {
    const text = buildOrderMessage('Mundo das Patas', [
      { name: 'Bola de Borracha Maciça', qty: 3 },
      { name: 'Guia Retrátil 5 m', qty: 1 },
    ]);
    expect(text).toContain('- Bola de Borracha Maciça — 3 unidades');
    expect(text).toContain('- Guia Retrátil 5 m — 1 unidade');
    expect(text.startsWith('Olá, Mundo das Patas!')).toBe(true);
  });

  it('mensagem de contato sem itens', () => {
    expect(buildOrderMessage('Loja', [])).toBe('Olá, Loja! Gostaria de mais informações sobre os produtos.');
  });

  it('link com 55 único e texto codificado', () => {
    const r = buildWhatsAppLink('+55 (21) 98888-7777', 'Olá — 2 un.\nOk & até já?');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url.startsWith('https://wa.me/5521988887777?text=')).toBe(true);
    const text = r.url.split('?text=')[1];
    expect(text).not.toMatch(/[\s&?]/);
    expect(decodeURIComponent(text)).toBe('Olá — 2 un.\nOk & até já?');
  });

  it('link recusado com número inválido', () => {
    expect(buildWhatsAppLink('123', 'oi')).toEqual({ ok: false, error: 'Informe DDD + número (10 ou 11 dígitos).' });
  });

  it('na demo nunca abre o WhatsApp', () => {
    let opened = false;
    expect(openWhatsApp('https://wa.me/5511900000000?text=oi', { open: () => ((opened = true), null) })).toBe(false);
    expect(opened).toBe(false);
  });
});
