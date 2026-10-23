import { useState } from 'react';
import { useNow } from '../../app/useNow';
import { useConfirm, useStore, useToast } from '../../app/contexts';
import { useIdempotencyKeys } from '../../app/useIdempotencyKeys';
import { Icon } from '../../components/Icon';
import { SALE_STATUS } from '../../components/status';
import { formatDateTime, units } from '../../domain/format';
import { completedSales, inPeriod, topSellers, unitsSold, type SalesPeriod } from '../../domain/reports';
import { useAdminUi } from '../admin/adminContext';
import { productName } from '../admin/productName';
import { TopList } from '../admin/widgets';
import { saleLabel } from './saleLabel';

const PERIODS: [SalesPeriod, string][] = [
  ['7', '7 dias'],
  ['30', '30 dias'],
  ['all', 'Tudo'],
];

export function SalesPage() {
  const { data, actions } = useStore();
  const ui = useAdminUi();
  const toast = useToast();
  const confirm = useConfirm();
  const [period, setPeriod] = useState<SalesPeriod>('30');
  const [busy, setBusy] = useState<string | null>(null);
  // Uma chave por venda: repetir o cancelamento depois de falha de rede não estorna duas vezes.
  const keys = useIdempotencyKeys();
  const now = useNow();
  const done = completedSales(data.sales, period, now);
  const top = topSellers(data.sales, period, now);
  const rows = data.sales.filter((s) => inPeriod(s.date, period, now));

  const cancel = async (id: string) => {
    if (busy) return;
    const label = saleLabel(id);
    const yes = await confirm({
      title: `Cancelar a venda ${label}?`,
      text: 'Os itens voltam para o estoque e a venda fica marcada como cancelada.',
      ok: 'Cancelar e estornar',
      danger: true,
    });
    if (!yes) return;
    setBusy(id);
    const r = await actions.cancelSale(id, { idempotencyKey: keys.keyFor(id) });
    setBusy(null);
    if (r.ok) keys.done(id);
    toast(r.ok ? `Venda ${label} cancelada. Estoque estornado.` : r.error);
  };

  return (
    <div className="admin-page" data-screen-label="Admin · Vendas">
      <div className="notice notice--warn">
        Encomendas enviadas pelo WhatsApp não geram venda automaticamente. Registre aqui apenas as vendas concluídas; o estoque é reduzido na confirmação.
      </div>
      <div className="admin-toolbar admin-toolbar--split">
        <div role="group" aria-label="Período" className="chips">
          {PERIODS.map(([id, label]) => (
            <button type="button" key={id} className="chip chip--compact" aria-pressed={period === id} onClick={() => setPeriod(id)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--primary btn--md" style={{ fontSize: 15 }} onClick={ui.openSale}>
          <Icon name="add" size={22} />
          Registrar venda
        </button>
      </div>

      <div className="sales-stats">
        <div className="metric">
          <div className="metric__value">{unitsSold(done)}</div>
          <div className="metric__label">Unidades vendidas</div>
        </div>
        <div className="metric">
          <div className="metric__value">{done.length}</div>
          <div className="metric__label">Vendas concluídas</div>
        </div>
      </div>

      <div className="admin-two-col admin-two-col--sales">
        <section className="panel">
          <h2 className="panel-title">Mais vendidos no período</h2>
          {top.length ? <TopList items={top} teal /> : <div className="panel-empty">Nenhuma venda no período.</div>}
        </section>
        <section className="panel" style={{ gap: 10 }}>
          <h2 className="panel-title">Histórico de vendas</h2>
          {rows.length ? (
            <div className="stack-8">
              {rows.map((s) => {
                const st = SALE_STATUS[s.status];
                return (
                  <div key={s.id} className="sale-card">
                    <div className="sale-card__head">
                      <span className="sale-card__id" title={s.id}>
                        {saleLabel(s.id)}
                      </span>
                      <span className={`badge badge--sm ${st.tone}`}>{st.label}</span>
                      <span className="sale-card__date">{formatDateTime(s.date)}</span>
                    </div>
                    <ul className="sale-card__lines">
                      {s.items.map((i, idx) => (
                        <li key={idx}>
                          {i.qty}× {productName(data, i.productId)}
                        </li>
                      ))}
                    </ul>
                    <div className="sale-card__foot">
                      <span>{units(s.items.reduce((a, i) => a + i.qty, 0))}</span>
                      {s.status === 'concluida' && (
                        <button type="button" className="btn btn--danger" style={{ borderRadius: 10, fontSize: 13, padding: '0 12px' }} disabled={busy === s.id} onClick={() => cancel(s.id)}>
                          Cancelar e estornar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="panel-empty">Nenhuma venda no período.</div>
          )}
        </section>
      </div>
    </div>
  );
}
