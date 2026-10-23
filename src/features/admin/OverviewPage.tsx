import { useNavigate } from 'react-router-dom';
import { useNow } from '../../app/useNow';
import { useStore } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { STOCK_ADMIN } from '../../components/status';
import { stockStatus } from '../../domain/catalog';
import { activeProducts, catalogSummary, completedSales, topSellers, unitsSold } from '../../domain/reports';
import { useAdminUi } from './adminContext';
import { MovementRow, PanelHead, TopList } from './widgets';

const plural = (n: number, s: string, p: string) => (n === 1 ? s : p);

export function OverviewPage() {
  const { data, dashboard } = useStore();
  const ui = useAdminUi();
  const navigate = useNavigate();
  const now = useNow();
  // Com a API, os indicadores vêm do servidor (`GET /admin/dashboard`), que considera todas as vendas.
  const s = dashboard?.catalog ?? catalogSummary(data);
  const done30 = completedSales(data.sales, '30', now);
  const sales30 = dashboard?.salesLast30Days ?? { count: done30.length, units: unitsSold(done30) };
  const top30 = topSellers(data.sales, '30', now);

  const offSub =
    [
      s.notPublished && `${s.notPublished} não publicado${plural(s.notPublished, '', 's')}`,
      s.hiddenByCategory && `${s.hiddenByCategory} por categoria inativa`,
      s.hiddenOutOfStock && `${s.hiddenOutOfStock} esgotado${plural(s.hiddenOutOfStock, '', 's')} oculto${plural(s.hiddenOutOfStock, '', 's')}`,
    ]
      .filter(Boolean)
      .join(' · ') || 'Todos os ativos estão visíveis';

  const metrics = [
    { l: 'Produtos cadastrados', v: s.active, i: 'inventory_2', tone: 'tone-brown', sub: 'Ativos, sem arquivados' },
    {
      l: 'Visíveis no catálogo',
      v: s.visible,
      i: 'storefront',
      tone: 'tone-ok',
      sub: `${s.published} publicados${s.inactiveCategories ? ` · ${s.inactiveCategories} categoria${plural(s.inactiveCategories, '', 's')} inativa${plural(s.inactiveCategories, '', 's')}` : ''}`,
    },
    { l: 'Fora do catálogo', v: s.active - s.visible, i: 'visibility_off', tone: 'tone-neutral', sub: offSub },
    { l: 'Estoque baixo', v: s.low, i: 'trending_down', tone: 'tone-low', sub: 'No mínimo ou abaixo' },
    { l: 'Esgotados', v: s.out, i: 'block', tone: 'tone-out', sub: 'Estoque zerado' },
    {
      l: 'Unidades vendidas · 30 dias',
      v: sales30.units,
      i: 'shopping_basket',
      tone: 'tone-peach',
      sub: `${sales30.count} venda${plural(sales30.count, '', 's')} concluída${plural(sales30.count, '', 's')}`,
    },
  ];

  const critical = activeProducts(data.products)
    .filter((p) => stockStatus(p) !== 'ok')
    .sort((a, b) => a.stock - b.stock);

  return (
    <div className="admin-page" data-screen-label="Admin · Visão geral">
      <div className="admin-toolbar admin-toolbar--split">
        <p className="admin-lead">Resumo do estoque e das vendas registradas.</p>
        <div className="admin-toolbar__actions">
          <button type="button" className="btn btn--secondary" style={{ fontWeight: 800, padding: '0 16px' }} onClick={() => ui.openProductForm(null)}>
            <Icon name="add" />
            Cadastrar produto
          </button>
          <button type="button" className="btn btn--primary" style={{ padding: '0 16px' }} onClick={ui.openSale}>
            <Icon name="point_of_sale" />
            Registrar venda
          </button>
        </div>
      </div>

      <div className="metric-grid">
        {metrics.map((m) => (
          <div key={m.l} className="metric">
            <span className={`metric__icon ${m.tone}`}>
              <Icon name={m.i} size={22} />
            </span>
            <div className="metric__value">{m.v}</div>
            <div className="metric__label">{m.l}</div>
            <div className="metric__sub">{m.sub}</div>
          </div>
        ))}
      </div>

      <div className="admin-two-col">
        <section className="panel">
          <PanelHead
            title="Estoque crítico"
            action={
              <button type="button" className="btn btn--link" onClick={() => navigate('/admin/estoque')}>
                Ver estoque
              </button>
            }
          />
          {critical.length ? (
            <div className="stack-8">
              {critical.map((p) => {
                const st = STOCK_ADMIN[stockStatus(p)];
                return (
                  <div key={p.id} className="critical-row">
                    <div className="critical-row__info">
                      <div className="critical-row__name">{p.name}</div>
                      <div className="critical-row__meta">
                        <span className={`badge badge--sm ${st.tone}`}>{st.label}</span>
                        <span>
                          {p.stock} un. · mínimo {p.minStock}
                        </span>
                      </div>
                    </div>
                    <button type="button" className="btn btn--teal" style={{ gap: 4 }} onClick={() => ui.openStockMove(p.id, 'entrada')}>
                      <Icon name="add" />
                      Repor
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="panel-empty panel-empty--center">Nenhum produto com estoque baixo ou esgotado.</div>
          )}
        </section>

        <section className="panel">
          <PanelHead
            title="Mais vendidos · 30 dias"
            action={
              <button type="button" className="btn btn--link" onClick={() => navigate('/admin/vendas')}>
                Ver vendas
              </button>
            }
          />
          {top30.length ? <TopList items={top30} /> : <div className="panel-empty">Nenhuma venda registrada nos últimos 30 dias.</div>}
        </section>
      </div>

      <section className="panel">
        <PanelHead
          title="Movimentações recentes"
          action={
            <button type="button" className="btn btn--link" onClick={() => navigate('/admin/estoque')}>
              Histórico completo
            </button>
          }
        />
        <div className="stack-0">
          {data.movements.slice(0, 6).map((m) => (
            <MovementRow key={m.id} m={m} />
          ))}
          {!data.movements.length && <div className="panel-empty">Sem movimentações registradas.</div>}
        </div>
      </section>
    </div>
  );
}
