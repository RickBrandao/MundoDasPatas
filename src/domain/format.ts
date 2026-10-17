/** Remove acentos e caixa para buscas ("Ração" encontra "racao"). */
export function normalizeText(x: unknown): string {
  return String(x ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Inteiro não negativo escrito só com dígitos ("0", "12"). */
export function isNonNegativeIntString(v: unknown): boolean {
  return /^\d+$/.test(String(v ?? '').trim());
}

export const pluralize = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const units = (n: number) => pluralize(n, 'unidade', 'unidades');

/** 17/10/26 · 14:05 */
export function formatDateTime(t: number): string {
  const d = new Date(t);
  return (
    d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
    ' · ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  );
}

export const DAY_MS = 864e5;
