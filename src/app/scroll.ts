/** Rola até uma seção da loja descontando o cabeçalho fixo. */
export function scrollToSection(id: string, behavior: ScrollBehavior = 'smooth') {
  const el = document.getElementById(id);
  if (!el) return;
  const offset = id === 'inicio' ? 200 : 84;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset), behavior });
}
