import { useEffect, useState } from 'react';
import { useCart, useUi } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { asset } from '../../components/productArt';
import { NAV_LINKS, useOpenAdmin } from './navigation';

export function StoreHeader() {
  const { count } = useCart();
  const { setCartOpen, goToSection } = useUi();
  const openAdmin = useOpenAdmin();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const go = (id: string) => {
    setMenuOpen(false);
    goToSection(id);
  };

  return (
    <header className="store-header">
      <div className="store-header__bar">
        <button type="button" className="store-header__logo" onClick={() => go('inicio')} aria-label="Mundo das Patas — início">
          <img src={asset('assets/logo.png')} alt="Mundo das Patas" />
        </button>
        <div className="spacer" />
        <nav aria-label="Navegação principal" className="store-nav">
          {NAV_LINKS.map(([label, id]) => (
            <button type="button" key={id} className="store-nav__link" onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
        <button type="button" className="store-header__admin" onClick={openAdmin}>
          <Icon name="admin_panel_settings" />
          Painel (demo)
        </button>
        <button
          type="button"
          className="cart-button"
          onClick={() => {
            setMenuOpen(false);
            setCartOpen(true);
          }}
          aria-label={`Abrir encomenda (${count} ${count === 1 ? 'item' : 'itens'})`}
        >
          <Icon name="shopping_bag" size={24} />
          {count > 0 && <span className="cart-button__count">{count}</span>}
        </button>
        <button
          type="button"
          className="menu-button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-controls="menu-mobile"
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={24} />
        </button>
      </div>
      {menuOpen && (
        <nav id="menu-mobile" aria-label="Menu" className="mobile-menu">
          {NAV_LINKS.map(([label, id]) => (
            <button type="button" key={id} className="mobile-menu__link" onClick={() => go(id)}>
              {label}
            </button>
          ))}
          <button
            type="button"
            className="mobile-menu__admin"
            onClick={() => {
              setMenuOpen(false);
              openAdmin();
            }}
          >
            <Icon name="admin_panel_settings" size={22} />
            Acessar painel (demonstração)
          </button>
        </nav>
      )}
    </header>
  );
}
