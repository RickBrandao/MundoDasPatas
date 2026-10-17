import { useNavigate } from 'react-router-dom';
import { useUi } from '../../app/contexts';
import type { Product } from '../../domain/types';

export const NAV_LINKS: [label: string, section: string][] = [
  ['Início', 'inicio'],
  ['Produtos', 'produtos'],
  ['Categorias', 'categorias'],
  ['Sobre Nós', 'sobre'],
  ['Contato', 'contato'],
];

export function useOpenAdmin() {
  const navigate = useNavigate();
  const { setCartOpen } = useUi();
  return () => {
    setCartOpen(false);
    navigate('/admin');
    window.scrollTo(0, 0);
  };
}

/** "Marca · Categoria" exibido nos cards e no detalhe. */
export function productMeta(p: Product, categoryName: string | undefined) {
  return [p.brand, categoryName].filter(Boolean).join(' · ');
}
