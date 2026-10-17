import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CartContext, useStore, useToast, type CartContextValue } from '../../app/contexts';
import { addToCart, cartCount, cartLines, reconcileCart, setCartQty } from '../../domain/cart';
import type { Cart } from '../../domain/types';
import type { CartStorage } from '../../services/cartStorage';

interface Props {
  storage: CartStorage;
  children: ReactNode;
}

/**
 * Encomenda do visitante. Sempre que estoque, publicação, categorias ou configurações
 * mudam, a encomenda é sincronizada (itens indisponíveis saem; quantidades são limitadas).
 */
export function CartProvider({ storage, children }: Props) {
  const { data } = useStore();
  const toast = useToast();
  const isAdmin = useLocation().pathname.startsWith('/admin');

  const [state, setState] = useState(() => {
    const r = reconcileCart(storage.load(), data);
    return { cart: r.cart, notice: r.messages.length ? r.messages.join(' · ') : null, syncedWith: data, adjustments: 0 };
  });

  // Sincroniza durante a renderização quando os dados da loja mudam (padrão recomendado pelo React).
  if (state.syncedWith !== data) {
    const r = reconcileCart(state.cart, data);
    setState({
      cart: r.cart,
      notice: r.changed && r.messages.length ? r.messages.join(' · ') : state.notice,
      syncedWith: data,
      adjustments: r.changed ? state.adjustments + 1 : state.adjustments,
    });
  }

  const isAdminRef = useRef(isAdmin);
  useEffect(() => {
    isAdminRef.current = isAdmin;
  }, [isAdmin]);
  useEffect(() => {
    if (state.adjustments > 0 && !isAdminRef.current) toast('Sua encomenda foi atualizada conforme o estoque.');
  }, [state.adjustments, toast]);

  useEffect(() => {
    storage.save(state.cart);
  }, [state.cart, storage]);

  // Cópia sempre atual da encomenda: cliques rápidos seguidos (antes de nova renderização) não se perdem.
  const latest = useRef(state.cart);
  useEffect(() => {
    latest.current = state.cart;
  }, [state.cart]);

  const value = useMemo<CartContextValue>(() => {
    const lines = cartLines(state.cart, data);
    const setCart = (cart: Cart) => {
      latest.current = cart;
      setState((s) => ({ ...s, cart }));
    };
    return {
      cart: state.cart,
      lines,
      count: cartCount(lines),
      notice: state.notice,
      dismissNotice: () => setState((s) => ({ ...s, notice: null })),
      add(productId, qty) {
        const r = addToCart(latest.current, data, productId, qty);
        switch (r.kind) {
          case 'unavailable':
          case 'invalid-qty':
            return toast('Produto indisponível no momento.');
          case 'at-max':
            return toast(`Quantidade máxima disponível: ${r.product.stock}.`);
          case 'clamped':
            setCart(r.cart);
            return toast(`Adicionado até o limite disponível (${r.product.stock}).`);
          case 'added':
            setCart(r.cart);
            return toast(`“${r.product.name}” adicionado à encomenda.`);
        }
      },
      setQty(productId, qty) {
        const current = latest.current;
        const next = setCartQty(current, data, productId, qty);
        if (!(productId in next) && productId in current) toast('Item removido da encomenda.');
        setCart(next);
      },
      clear: () => setCart({}),
    };
  }, [state.cart, state.notice, data, toast]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
