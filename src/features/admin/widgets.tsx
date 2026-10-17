import { useStore } from '../../app/contexts';
import { MOVEMENT } from '../../components/status';
import { formatDateTime } from '../../domain/format';
import type { TopSeller } from '../../domain/reports';
import type { StockMovement } from '../../domain/types';
import { productName } from './productName';

export function MovementRow({ m, withNote = false }: { m: StockMovement; withNote?: boolean }) {
  const { data } = useStore();
  const t = MOVEMENT[m.type] ?? MOVEMENT.ajuste;
  return (
    <div className="move-row">
      <span className={`badge ${t.tone}`}>{t.label}</span>
      <div className="move-row__name">
        {productName(data, m.productId)}
        {withNote && (
          <div className="move-row__note">
            {m.note} · {m.origin}
          </div>
        )}
      </div>
      <span className={`move-row__qty ${m.qty > 0 ? 'move-row__qty--in' : 'move-row__qty--out'}`}>
        {m.qty > 0 ? '+' : '−'}
        {Math.abs(m.qty)}
      </span>
      <span className="move-row__date">{formatDateTime(m.date)}</span>
    </div>
  );
}

export function TopList({ items, teal = false }: { items: TopSeller[]; teal?: boolean }) {
  const { data } = useStore();
  return (
    <ol className="rank-list">
      {items.map((t, i) => (
        <li key={t.productId}>
          <div className="rank-row">
            <span>
              {i + 1}. {productName(data, t.productId)}
            </span>
            <span>{t.units} un.</span>
          </div>
          <div className="rank-track">
            <div className={`rank-bar ${teal ? 'rank-bar--teal' : ''}`} style={{ width: `${t.pct}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function PanelHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="panel-head">
      <h2 className="panel-title">{title}</h2>
      {action}
    </div>
  );
}
