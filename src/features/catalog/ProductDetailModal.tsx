import { useState } from 'react';
import { useCart, useStore, useToast, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ProductImage } from '../../components/ProductImage';
import { imageFor } from '../../components/productArt';
import { STOCK_PUBLIC } from '../../components/status';
import { stockStatus } from '../../domain/catalog';
import { formatBRL, hasPublicPrice } from '../../domain/money';
import type { Product } from '../../domain/types';
import { productMeta } from './navigation';

const TONE = { ok: 'tone-ok', low: 'tone-low', out: 'tone-out' } as const;

/** Detalhes do produto. No painel funciona como pré-visualização ("Ver como o cliente"). */
export function ProductDetailModal({ adminPreview }: { adminPreview: boolean }) {
  const { data } = useStore();
  const { detailId, closeDetail } = useUi();
  const product = detailId ? data.products.find((p) => p.id === detailId) : undefined;
  if (!product) return null;
  // `key` reinicia a quantidade escolhida ao trocar de produto.
  return <DetailContent key={product.id} product={product} adminPreview={adminPreview} onClose={closeDetail} />;
}

function DetailContent({ product: p, adminPreview, onClose }: { product: Product; adminPreview: boolean; onClose: () => void }) {
  const { data } = useStore();
  const { add } = useCart();
  const toast = useToast();
  const [qty, setQty] = useState(1);
  const st = stockStatus(p);
  const [artShown, setArtShown] = useState(imageFor(p).isArt);
  const category = data.categories.find((c) => c.id === p.categoryId);
  const price = hasPublicPrice(p);

  return (
    <Modal label={p.name} onClose={onClose} overlayClassName="overlay--detail" className="dialog detail">
      <div className="detail__close">
        <button type="button" onClick={onClose} aria-label="Fechar">
          <Icon name="close" size={22} />
        </button>
      </div>
      <div className="detail__media">
        {artShown && <span className="detail__art-tag">Ilustração demonstrativa</span>}
        <ProductImage product={p} onFallback={() => setArtShown(true)} />
      </div>
      <div className="detail__body">
        <div className="detail__meta">{productMeta(p, category?.name)}</div>
        <h2 className="detail__name">{p.name}</h2>
        <span className={`detail__status ${TONE[st]}`}>{STOCK_PUBLIC[st]}</span>
        {price ? <div className="detail__price">{formatBRL(p.priceCents!)}</div> : <div className="detail__ask">Preço: consulte pelo WhatsApp</div>}
        <p className="detail__desc">{p.description}</p>
        {adminPreview ? (
          <div className="detail__notice">Pré-visualização do cliente · {p.archived ? 'Arquivado' : p.published ? 'Publicado no catálogo' : 'Oculto do catálogo'}</div>
        ) : st === 'out' ? (
          <div className="alert alert--danger" style={{ padding: '12px 14px', borderRadius: 12 }}>
            Indisponível no momento. Fale com a loja pelo WhatsApp para saber a previsão.
          </div>
        ) : (
          <div className="detail__buy">
            <div className="stepper stepper--lg">
              <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Diminuir">
                <Icon name="remove" size={22} />
              </button>
              <span aria-live="polite">{qty}</span>
              <button
                type="button"
                onClick={() => (qty < p.stock ? setQty(qty + 1) : toast('Quantidade máxima disponível.'))}
                aria-label="Aumentar"
              >
                <Icon name="add" size={22} />
              </button>
            </div>
            <button
              type="button"
              className="btn btn--primary detail__add"
              onClick={() => {
                add(p.id, qty);
                onClose();
              }}
            >
              <Icon name="add_shopping_cart" size={22} />
              Adicionar à encomenda
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

