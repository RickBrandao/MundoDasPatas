export type PhoneResult =
  | { ok: true; national: string; e164: string }
  | { ok: false; error: string };

/**
 * Normaliza um WhatsApp brasileiro. Aceita com ou sem +55, com máscara,
 * e devolve o número no formato usado pelo wa.me (55 + DDD + número), sem duplicar o 55.
 */
export function normalizePhone(input: unknown): PhoneResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Informe o WhatsApp com DDD.' };
  if (/[^\d\s()+\-.]/.test(raw)) {
    return { ok: false, error: 'Use apenas números, espaços, parênteses, hífen e +.' };
  }

  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    if (!d.startsWith('55') || (d.length !== 12 && d.length !== 13)) {
      return { ok: false, error: 'Somente números do Brasil (+55) com DDD são aceitos.' };
    }
    d = d.slice(2);
  } else {
    if (d.startsWith('0')) d = d.slice(1);
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  }

  if (d.length !== 10 && d.length !== 11) {
    return { ok: false, error: 'Informe DDD + número (10 ou 11 dígitos).' };
  }
  if (d[0] === '0' || d[1] === '0') return { ok: false, error: 'DDD inválido.' };
  if (d.length === 11 && d[2] !== '9') {
    return { ok: false, error: 'Celular com 11 dígitos deve ter 9 após o DDD.' };
  }
  return { ok: true, national: d, e164: '55' + d };
}
