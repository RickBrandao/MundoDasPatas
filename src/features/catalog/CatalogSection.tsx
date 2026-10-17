import { useMemo } from 'react';
import { useStore } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { filterCatalog, type CatalogAvailability, type CatalogFilters, type CatalogSort } from '../../domain/catalog';
import { pluralize } from '../../domain/format';
import { ProductCard } from './ProductCard';

interface Props {
  filters: CatalogFilters;
  onChange: (f: CatalogFilters) => void;
}

export function CatalogSection({ filters, onChange }: Props) {
  const { data } = useStore();
  const catalog = useMemo(() => filterCatalog(data.products, data, filters), [data, filters]);
  const activeCats = data.categories.filter((c) => c.active);
  const set = (patch: Partial<CatalogFilters>) => onChange({ ...filters, ...patch });

  return (
    <section id="produtos" className="section section--catalog">
      <div className="section-head section-head--split">
        <div className="section-title">
          <span className="eyebrow">Catálogo</span>
          <h2>Todos os produtos</h2>
        </div>
        <span aria-live="polite" className="results-label">
          {pluralize(catalog.length, 'produto', 'produtos')}
        </span>
      </div>

      <div className="catalog-filters">
        <label className="search search--public">
          <Icon name="search" size={22} />
          <input
            type="search"
            className="input"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Buscar por nome, marca ou categoria"
            aria-label="Buscar produtos"
          />
        </label>
        <select
          className="select catalog-select"
          value={filters.availability}
          onChange={(e) => set({ availability: e.target.value as CatalogAvailability })}
          aria-label="Disponibilidade"
        >
          <option value="all">Todos os produtos</option>
          <option value="in">Somente disponíveis</option>
        </select>
        <select className="select catalog-select" value={filters.sort} onChange={(e) => set({ sort: e.target.value as CatalogSort })} aria-label="Ordenar">
          <option value="featured">Destaques primeiro</option>
          <option value="name">Nome (A–Z)</option>
          <option value="asc">Menor preço</option>
          <option value="desc">Maior preço</option>
        </select>
      </div>

      <div role="group" aria-label="Filtrar por categoria" className="chips catalog-chips">
        {[{ id: 'all', name: 'Todas' }, ...activeCats].map((c) => (
          <button type="button" key={c.id} className="chip" aria-pressed={filters.categoryId === c.id} onClick={() => set({ categoryId: c.id })}>
            {c.name}
          </button>
        ))}
      </div>

      {catalog.length > 0 ? (
        <div className="product-grid" style={{ marginTop: 20 }}>
          {catalog.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      ) : (
        <div className="empty-results">
          <Icon name="search_off" size={44} style={{ color: 'var(--c-line-dashed)' }} />
          <div className="empty-results__title">Nenhum produto encontrado</div>
          <div className="empty-results__text">Tente outro termo ou categoria. Se não encontrar, fale com a loja pelo WhatsApp.</div>
          <button type="button" className="btn btn--teal btn--pill" style={{ marginTop: 6, borderWidth: 2, padding: '0 20px' }} onClick={() => set({ q: '', categoryId: 'all', availability: 'all' })}>
            Limpar filtros
          </button>
        </div>
      )}
    </section>
  );
}
