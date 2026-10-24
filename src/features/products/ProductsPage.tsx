import { useState } from 'react';
import { useConfirm, useStore, useToast, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { ProductImage } from '../../components/ProductImage';
import { PUBLIC_STATE, STOCK_ADMIN } from '../../components/status';
import { stockStatus } from '../../domain/catalog';
import { normalizeText } from '../../domain/format';
import { formatBRL } from '../../domain/money';
import { publicState } from '../../domain/reports';
import type { Product } from '../../domain/types';
import { useAdminUi } from '../admin/adminContext';

type Filter = 'all' | 'pub' | 'hidden' | 'arch';
const FILTERS: [Filter, string, (p: Product) => boolean][] = [
  ['all', 'Ativos', (p) => !p.archived],
  ['pub', 'Publicados', (p) => p.published && !p.archived],
  ['hidden', 'Ocultos', (p) => !p.published && !p.archived],
  ['arch', 'Arquivados', (p) => p.archived],
];

export function ProductsPage() {
  const { data, actions } = useStore();
  const { openDetail } = useUi();
  const ui = useAdminUi();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Uma alteração por vez em cada produto (evita cliques repetidos enquanto o servidor responde).
  const [busy, setBusy] = useState<string | null>(null);

  const test = FILTERS.find((f) => f[0] === filter)![2];
  const nq = normalizeText(q.trim());
  const rows = data.products.filter((p) => test(p) && (!nq || normalizeText(`${p.name} ${p.brand}`).includes(nq)));
  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? '—';

  const patch = async (p: Product, flags: Parameters<typeof actions.patchProduct>[1], message: string) => {
    if (busy) return;
    setBusy(p.id);
    const r = await actions.patchProduct(p.id, flags);
    setBusy(null);
    toast(r.ok ? message : r.error);
  };
  const archive = async (p: Product) => {
    const yes = await confirm({
      title: 'Arquivar produto?',
      text: `“${p.name}” sairá do catálogo e da lista ativa. O histórico de estoque e vendas é mantido.`,
      ok: 'Arquivar',
      danger: true,
    });
    if (yes) await patch(p, { archived: true, published: false }, 'Produto arquivado.');
  };

  return (
    <div className="admin-page" data-screen-label="Admin · Produtos">
      <div className="admin-toolbar">
        <label className="search">
          <Icon name="search" size={22} />
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto ou marca" aria-label="Buscar produto" />
        </label>
        <button type="button" className="btn btn--primary btn--md" style={{ fontSize: 15 }} onClick={() => ui.openProductForm(null)}>
          <Icon name="add" size={22} />
          Novo produto
        </button>
      </div>

      <div className="chips">
        {FILTERS.map(([id, label, t]) => (
          <button type="button" key={id} className="chip chip--compact" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label} ({data.products.filter(t).length})
          </button>
        ))}
      </div>

      {rows.length ? (
        <div className="stack-8">
          {rows.map((p) => {
            const st = STOCK_ADMIN[stockStatus(p)];
            const pub = PUBLIC_STATE[publicState(p, data)];
            return (
              <div key={p.id} className="admin-row">
                <div className="admin-row__main">
                  <div className="thumb" style={{ width: 56, height: 56 }}>
                    <ProductImage product={p} loading="lazy" />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <button type="button" className="admin-row__name" onClick={() => ui.openProductForm(p)}>
                      {p.name}
                    </button>
                    <div className="admin-row__meta">
                      {[p.brand, catName(p.categoryId)].filter(Boolean).join(' · ')} ·{' '}
                      {p.priceCents != null && p.priceCents > 0 ? formatBRL(p.priceCents) + (p.showPrice ? '' : ' · preço oculto') : 'Sem preço · sob consulta'}
                    </div>
                  </div>
                </div>
                <div className="admin-row__badges">
                  <span className="admin-row__stock">{p.stock} un.</span>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                  <span className={`badge ${pub.tone}`}>{pub.label}</span>
                </div>
                <div className="admin-row__actions">
                  {p.archived ? (
                    <button type="button" className="btn btn--secondary" onClick={() => patch(p, { archived: false }, 'Produto restaurado (oculto). Publique quando quiser.')}>
                      <Icon name="unarchive" />
                      Restaurar
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn btn--secondary" onClick={() => ui.openProductForm(p)}>
                        <Icon name="edit" />
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => patch(p, { published: !p.published }, p.published ? 'Produto ocultado do catálogo.' : 'Produto publicado no catálogo.')}
                      >
                        <Icon name={p.published ? 'visibility_off' : 'visibility'} />
                        {p.published ? 'Ocultar' : 'Publicar'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--icon"
                        style={{ color: p.featured ? 'var(--c-orange)' : '#9A8676' }}
                        aria-label={p.featured ? 'Remover destaque' : 'Marcar como destaque'}
                        title={p.featured ? 'Remover destaque' : 'Marcar como destaque'}
                        aria-pressed={p.featured}
                        onClick={() => patch(p, { featured: !p.featured }, p.featured ? 'Destaque removido.' : 'Produto marcado como destaque.')}
                      >
                        <Icon name="star" size={22} filled={p.featured} />
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--icon"
                        style={{ color: 'var(--c-text-2)' }}
                        aria-label="Ver como o cliente"
                        title="Ver como o cliente"
                        onClick={() => openDetail(p.id)}
                      >
                        <Icon name="open_in_new" size={22} />
                      </button>
                      <button type="button" className="btn btn--danger btn--icon" aria-label="Arquivar produto" title="Arquivar" onClick={() => archive(p)}>
                        <Icon name="archive" size={22} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="admin-empty">
          <div className="admin-empty__title">Nenhum produto nesta lista</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>Ajuste a busca ou o filtro, ou cadastre um novo produto.</div>
        </div>
      )}
    </div>
  );
}
