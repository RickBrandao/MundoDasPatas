import { useCart, useStore, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { ProductImage } from '../../components/ProductImage';
import { STOCK_PUBLIC } from '../../components/status';
import { stockStatus } from '../../domain/catalog';
import { formatBRL, hasPublicPrice } from '../../domain/money';
import type { Product } from '../../domain/types';
import { productMeta } from './navigation';

const PUBLIC_TONE = { ok: 'tone-ok', low: 'tone-low', out: 'tone-out' } as const;

export function ProductCard({ product: p }: { product: Product }) {
  const { data } = useStore();
  const { add } = useCart();
  const { openDetail } = useUi();
  const st = stockStatus(p);
  const category = data.categories.find((c) => c.id === p.categoryId);
  const price = hasPublicPrice(p);

  return (
    <article className="pcard">
      <button type="button" className="pcard__media" onClick={() => openDetail(p.id)} aria-label={`Ver detalhes de ${p.name}`}>
        <ProductImage product={p} loading="lazy" decoding="async" />
        <span className={`pcard__status ${PUBLIC_TONE[st]}`}>{STOCK_PUBLIC[st]}</span>
      </button>
      <div className="pcard__body">
        <div className="pcard__meta">{productMeta(p, category?.name)}</div>
        <h3 className="pcard__name">{p.name}</h3>
        <div className="pcard__price">
          {price ? <span className="price">{formatBRL(p.priceCents!)}</span> : <span className="price-ask">Consulte pelo WhatsApp</span>}
        </div>
        {st === 'out' ? (
          <button type="button" className="pcard__out" disabled>
            Indisponível
          </button>
        ) : (
          <button type="button" className="pcard__add" onClick={() => add(p.id, 1)}>
            <Icon name="add_shopping_cart" />
            <span>
              Adicionar<span className="pcard__add-long"> à encomenda</span>
            </span>
          </button>
        )}
      </div>
    </article>
  );
}
