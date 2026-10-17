import { formatBRL, formatPriceInput, parseBRL } from '../../domain/money';
import { normalizePhone } from '../../domain/phone';

export interface SelfCheck {
  name: string;
  pass: boolean;
}

/**
 * Verificações de regressão exibidas em Configurações (herdadas do protótipo).
 * A suíte completa roda com `npm test`; esta lista confirma as regras no navegador do proprietário.
 */
export function runSelfChecks(): SelfCheck[] {
  const r: SelfCheck[] = [];
  const t = (name: string, pass: boolean) => r.push({ name, pass });
  const e164 = (s: string) => {
    const p = normalizePhone(s);
    return p.ok ? p.e164 : null;
  };
  t('Preço "49,90" → R$ 49,90', parseBRL('49,90') === 4990);
  t('Preço "189,99" → R$ 189,99', parseBRL('189,99') === 18999);
  t('Preço "1.234,56" → R$ 1.234,56', parseBRL('1.234,56') === 123456);
  t('Preço "1234,56" → R$ 1.234,56', parseBRL('1234,56') === 123456);
  t('Preço "R$ 1.234,56" → R$ 1.234,56', parseBRL('R$ 1.234,56') === 123456);
  t('Preço "12.345.678,90" → R$ 12.345.678,90', parseBRL('12.345.678,90') === 1234567890);
  t('Preço "49.90" → R$ 49,90', parseBRL('49.90') === 4990);
  t('Preço "1.234" → R$ 1.234,00', parseBRL('1.234') === 123400);
  t('Preço "12,345" rejeitado', Number.isNaN(parseBRL('12,345')));
  t('Preço "1,234,56" rejeitado', Number.isNaN(parseBRL('1,234,56')));
  t('Preço "12.34,5" rejeitado', Number.isNaN(parseBRL('12.34,5')));
  t('Preço "abc" rejeitado', Number.isNaN(parseBRL('abc')));
  t('Preço vazio → sem preço', parseBRL('') === null);
  t('Exibição 123456 centavos → "R$ 1.234,56"', formatBRL(123456).replace(/\s/g, ' ') === 'R$ 1.234,56');
  t('Edição 123456 centavos → "1.234,56"', formatPriceInput(123456) === '1.234,56');
  t('WhatsApp "(11) 98888-7777" → 5511988887777', e164('(11) 98888-7777') === '5511988887777');
  t('WhatsApp "+55 11 98888-7777" sem duplicar 55', e164('+55 11 98888-7777') === '5511988887777');
  t('WhatsApp "5511988887777" sem duplicar 55', e164('5511988887777') === '5511988887777');
  t('WhatsApp DDD 55 "(55) 99999-8888" preservado', e164('(55) 99999-8888') === '5555999998888');
  t('WhatsApp fixo "(11) 3333-4444" aceito', e164('(11) 3333-4444') === '551133334444');
  t('WhatsApp "123" rejeitado', !normalizePhone('123').ok);
  t('WhatsApp "+1 415 555 0100" rejeitado', !normalizePhone('+1 415 555 0100').ok);
  t('WhatsApp "(11) 88888-7777" rejeitado', !normalizePhone('(11) 88888-7777').ok);
  t(
    'Mensagem codificada (encodeURIComponent)',
    encodeURIComponent('Olá — 2 un.\nOk').includes('%E2%80%94') && !/\s/.test(encodeURIComponent('a b\nc')),
  );
  return r;
}
