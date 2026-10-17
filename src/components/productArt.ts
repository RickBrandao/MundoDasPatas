import type { Product } from '../domain/types';

/** Caminho de um arquivo em `public/`, respeitando o `base` do Vite (GitHub Pages). */
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;

const SEED_ART = new Set(Array.from({ length: 19 }, (_, i) => `p${i + 1}`));
const CATEGORY_ART = new Set(['racoes', 'petiscos', 'brinquedos', 'acessorios', 'higiene']);

/** Ilustração demonstrativa: SVG próprio dos 19 produtos fictícios, senão a da categoria. */
export function artFor(p: Pick<Product, 'id' | 'categoryId'>): string {
  if (SEED_ART.has(p.id)) return asset(`assets/produtos/${p.id}.svg`);
  return asset(`assets/produtos/cat-${CATEGORY_ART.has(p.categoryId) ? p.categoryId : 'default'}.svg`);
}

/** Imagem a exibir: foto enviada no painel ou ilustração demonstrativa. */
export function imageFor(p: Pick<Product, 'id' | 'categoryId' | 'imageUrl'>): { src: string; isArt: boolean } {
  return p.imageUrl ? { src: p.imageUrl, isArt: false } : { src: artFor(p), isArt: true };
}
