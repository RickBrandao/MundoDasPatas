import { units } from './format';
import { normalizePhone } from './phone';

/**
 * Enquanto `false`, a demo apenas exibe a prévia e o link — nada é aberto nem enviado.
 * Para habilitar o redirecionamento real, troque para `true` depois de validar
 * o número oficial da loja em Configurações.
 */
export const WHATSAPP_REDIRECT_ENABLED = false;

export interface OrderLine {
  name: string;
  qty: number;
}

export function buildOrderMessage(storeName: string, lines: OrderLine[]): string {
  if (!lines.length) return `Olá, ${storeName}! Gostaria de mais informações sobre os produtos.`;
  const list = lines.map((l) => `- ${l.name} — ${units(l.qty)}`).join('\n');
  return (
    `Olá, ${storeName}! Gostaria de consultar a disponibilidade dos seguintes produtos:\n\n` +
    `${list}\n\n` +
    'Poderiam confirmar a disponibilidade e me informar como funciona a entrega ou retirada? Obrigado!'
  );
}

export type WhatsAppLink = { ok: true; url: string } | { ok: false; error: string };

/** Monta o link wa.me com número validado (55 único) e mensagem codificada. */
export function buildWhatsAppLink(phone: string, text: string): WhatsAppLink {
  const p = normalizePhone(phone);
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, url: `https://wa.me/${p.e164}?text=${encodeURIComponent(text)}` };
}

/**
 * Ponto único de abertura do WhatsApp. Na demo retorna `false` sem abrir nada.
 * Nunca registra venda: encomendas só viram venda quando a loja registra no painel.
 */
export function openWhatsApp(url: string, win: Pick<Window, 'open'> = window): boolean {
  if (!WHATSAPP_REDIRECT_ENABLED) return false;
  if (!url.startsWith('https://wa.me/')) return false;
  win.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
