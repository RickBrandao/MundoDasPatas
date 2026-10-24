import { useCart, useConfirm, useStore, useToast, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { CloseButton, Modal } from '../../components/Modal';
import { ProductImage } from '../../components/ProductImage';
import { pluralize } from '../../domain/format';
import { formatBRL, hasPublicPrice } from '../../domain/money';
import { buildOrderMessage } from '../../domain/whatsapp';

export function CartDrawer() {
  const { data } = useStore();
  const { lines, count, notice, dismissNotice, setQty, clear } = useCart();
  const { cartOpen, setCartOpen, setWa, goToSection } = useUi();
  const confirm = useConfirm();
  const toast = useToast();
  if (!cartOpen) return null;

  const close = () => setCartOpen(false);
  const continueShopping = () => {
    close();
    goToSection('produtos');
  };
  const countLabel = pluralize(count, 'item', 'itens');

  return (
    <Modal label="Sua encomenda" onClose={close} variant="drawer" className="drawer">
      <div className="drawer__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="drawer__title">Sua encomenda</h2>
          <div className="drawer__count">{countLabel}</div>
        </div>
        <CloseButton onClick={close} />
      </div>

      {notice && (
        <div role="status" className="cart-notice">
          <span>
            <strong>Encomenda ajustada ao estoque:</strong> {notice}
          </span>
          <button type="button" onClick={dismissNotice} aria-label="Dispensar aviso">
            <Icon name="close" />
          </button>
        </div>
      )}

      {count > 0 ? (
        <>
          <div className="drawer__list">
            {lines.map(({ product: p, qty, atMax }) => (
              <div key={p.id} className="cart-line">
                <div className="thumb" style={{ width: 64, height: 64 }}>
                  <ProductImage product={p} />
                </div>
                <div className="cart-line__body">
                  <div className="cart-line__name">{p.name}</div>
                  <div className="cart-line__unit">{hasPublicPrice(p) ? `${formatBRL(p.priceCents!)} / un.` : 'Preço sob consulta'}</div>
                  <div className="cart-line__row">
                    <div className="stepper">
                      <button type="button" onClick={() => setQty(p.id, qty - 1)} aria-label="Diminuir quantidade">
                        <Icon name="remove" />
                      </button>
                      <span aria-live="polite">{qty}</span>
                      <button
                        type="button"
                        onClick={() => (atMax ? toast('Quantidade máxima disponível.') : setQty(p.id, qty + 1))}
                        aria-label="Aumentar quantidade"
                        style={{ opacity: atMax ? 0.35 : 1 }}
                      >
                        <Icon name="add" />
                      </button>
                    </div>
                    <button type="button" className="cart-line__remove" onClick={() => setQty(p.id, 0)} aria-label={`Remover ${p.name}`}>
                      <Icon name="delete" size={22} />
                    </button>
                  </div>
                  {atMax && <div className="cart-line__max">Quantidade máxima disponível</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="drawer__foot">
            <div className="drawer__disclaimer">
              Esta lista não é uma compra. A loja confirma disponibilidade, valores, entrega ou retirada e pagamento pelo WhatsApp.
            </div>
            <button
              type="button"
              className="btn btn--primary drawer__order"
              onClick={() =>
                setWa({
                  text: buildOrderMessage(
                    data.settings.storeName,
                    lines.map((l) => ({ name: l.product.name, qty: l.qty })),
                  ),
                  step: 1,
                  fromCart: true,
                })
              }
            >
              <Icon name="chat" size={22} />
              Encomendar pelo WhatsApp
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn--secondary btn--grow" onClick={continueShopping}>
                Continuar escolhendo
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={async () => {
                  const yes = await confirm({ title: 'Limpar encomenda?', text: 'Todos os itens serão removidos da sua lista.', ok: 'Limpar', danger: true });
                  if (yes) {
                    clear();
                    toast('Encomenda limpa.');
                  }
                }}
              >
                Limpar
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="drawer__empty">
          <Icon name="shopping_bag" size={52} style={{ color: '#D9C8B3' }} />
          <div className="drawer__empty-title">Sua encomenda está vazia</div>
          <div className="drawer__empty-text">Adicione produtos do catálogo para montar sua lista.</div>
          <button type="button" className="btn btn--primary btn--pill btn--md" style={{ marginTop: 8, padding: '0 22px' }} onClick={continueShopping}>
            Ver produtos
          </button>
        </div>
      )}
    </Modal>
  );
}
