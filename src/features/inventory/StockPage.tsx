import { useState } from 'react';
import { useStore } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { MOVEMENT, STOCK_ADMIN } from '../../components/status';
import { stockStatus } from '../../domain/catalog';
import { formatDateTime, normalizeText } from '../../domain/format';
import { activeProducts } from '../../domain/reports';
import type { StockStatus } from '../../domain/types';
import { useAdminUi } from '../admin/adminContext';
import { productName } from '../admin/productName';
import { MovementRow } from '../admin/widgets';

type Filter = 'all' | StockStatus;

export function StockPage() {
  const { data } = useStore();
  const ui = useAdminUi();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [histId, setHistId] = useState<string | null>(null);

  const act = activeProducts(data.products);
  const counts = { all: act.length, ok: 0, low: 0, out: 0 };
  act.forEach((p) => counts[stockStatus(p)]++);
  const nq = normalizeText(q.trim());
  const rows = act
    .filter((p) => (filter === 'all' || stockStatus(p) === filter) && (!nq || normalizeText(p.name).includes(nq)))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const history = data.movements.filter((m) => !histId || m.productId === histId).slice(0, 25);
  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? '—';

  const showHistory = (id: string) => {
    setHistId(id);
    setTimeout(() => {
      const el = document.getElementById('historico');
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
    }, 40);
  };

  const chips: [Filter, string][] = [
    ['all', 'Todos'],
    ['ok', 'Disponível'],
    ['low', 'Estoque baixo'],
    ['out', 'Esgotado'],
  ];

  return (
    <div className="admin-page" data-screen-label="Admin · Estoque">
      <div className="admin-toolbar">
        <label className="search">
          <Icon name="search" size={22} />
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto" aria-label="Buscar produto no estoque" />
        </label>
        <button type="button" className="btn btn--secondary btn--md" style={{ fontWeight: 800, padding: '0 16px' }} onClick={ui.openSale}>
          <Icon name="point_of_sale" />
          Baixa por venda
        </button>
      </div>

      <div className="chips">
        {chips.map(([id, label]) => (
          <button type="button" key={id} className="chip chip--compact" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label} ({counts[id]})
          </button>
        ))}
      </div>

      {rows.length ? (
        <div className="stack-8">
          {rows.map((p) => {
            const st = STOCK_ADMIN[stockStatus(p)];
            const last = data.movements.find((m) => m.productId === p.id);
            return (
              <div key={p.id} className="admin-row admin-row--stock">
                <div className="stock-row__info">
                  <div className="stock-row__name">{p.name}</div>
                  <div className="admin-row__meta">
                    {catName(p.categoryId)} · Última: {last ? `${(MOVEMENT[last.type] ?? MOVEMENT.ajuste).label} · ${formatDateTime(last.date)}` : 'Sem movimentações'}
                  </div>
                </div>
                <div className="stock-row__qty">
                  <div style={{ textAlign: 'right' }}>
                    <div className="stock-row__num">{p.stock}</div>
                    <div className="stock-row__min">mín. {p.minStock}</div>
                  </div>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                </div>
                <div className="admin-row__actions">
                  <button type="button" className="btn btn--teal" style={{ gap: 4, padding: '0 12px' }} onClick={() => ui.openStockMove(p.id, 'entrada')}>
                    <Icon name="add" />
                    Entrada
                  </button>
                  <button type="button" className="btn btn--secondary" style={{ gap: 4, padding: '0 12px' }} onClick={() => ui.openStockMove(p.id, 'ajuste')}>
                    <Icon name="tune" />
                    Ajuste
                  </button>
                  <button type="button" className="btn btn--secondary btn--icon" aria-label={`Histórico de ${p.name}`} title="Histórico" onClick={() => showHistory(p.id)}>
                    <Icon name="history" size={22} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="admin-empty" style={{ padding: 32, fontSize: 14 }}>
          Nenhum produto encontrado com esse filtro.
        </div>
      )}

      <section id="historico" className="panel" style={{ gap: 8, marginTop: 8 }}>
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <h2 className="panel-title">Histórico de movimentações</h2>
          {histId && (
            <button type="button" className="hist-filter" onClick={() => setHistId(null)} aria-label={`Remover filtro: ${productName(data, histId)}`}>
              {productName(data, histId)}
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        {history.length ? (
          <div className="stack-0">
            {history.map((m) => (
              <MovementRow key={m.id} m={m} withNote />
            ))}
          </div>
        ) : (
          <div className="panel-empty">Sem movimentações registradas.</div>
        )}
      </section>
    </div>
  );
}
