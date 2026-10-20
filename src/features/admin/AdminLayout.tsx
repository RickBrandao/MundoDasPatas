import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { asset } from '../../components/productArt';
import type { Category, Product } from '../../domain/types';
import { ProductDetailModal } from '../catalog/ProductDetailModal';
import { CategoryFormModal } from '../categories/CategoryFormModal';
import { StockMoveModal } from '../inventory/StockMoveModal';
import { useOptionalAdminSession } from '../auth/adminSession';
import { ProductFormModal } from '../products/ProductFormModal';
import { SaleModal } from '../sales/SaleModal';
import { ADMIN_TABS, AdminUiContext, type AdminUi } from './adminContext';

type AdminModal =
  | { kind: 'product'; product: Product | null }
  | { kind: 'stock'; productId: string; type: 'entrada' | 'ajuste' }
  | { kind: 'sale' }
  | { kind: 'category'; category: Category | null }
  | null;

export function AdminLayout() {
  const { storageFail, persistent } = useStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [modal, setModal] = useState<AdminModal>(null);
  // Presente só no modo autenticado (Firebase); `null` na demonstração.
  const auth = useOptionalAdminSession();
  const signedInEmail = auth?.session.status === 'authorized' ? auth.session.user.email : null;

  const tab = ADMIN_TABS.find((t) => pathname.endsWith(`/${t.path}`)) ?? ADMIN_TABS[0];
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab.path]);
  useEffect(() => {
    document.title = `${tab.label} · Painel · Mundo das Patas`;
    return () => {
      document.title = 'Mundo das Patas';
    };
  }, [tab.label]);

  const ui = useMemo<AdminUi>(
    () => ({
      openProductForm: (product) => setModal({ kind: 'product', product }),
      openStockMove: (productId, type) => setModal({ kind: 'stock', productId, type }),
      openSale: () => setModal({ kind: 'sale' }),
      openCategoryForm: (category) => setModal({ kind: 'category', category }),
    }),
    [],
  );
  const close = () => setModal(null);
  const openStore = () => {
    navigate('/');
    window.scrollTo(0, 0);
  };

  const navItems = (variant: 'side' | 'chips') =>
    ADMIN_TABS.map((t) => (
      <NavLink key={t.path} to={`/admin/${t.path}`} className={variant === 'side' ? 'admin-side__link' : 'admin-chipnav__link'}>
        <Icon name={t.icon} size={variant === 'side' ? 22 : 20} />
        {t.label}
      </NavLink>
    ));

  return (
    <AdminUiContext.Provider value={ui}>
      <div className="admin" data-screen-label="Painel administrativo">
        <aside className="admin-side">
          <div className="admin-side__brand">
            <img src={asset('assets/logo.png')} alt="Mundo das Patas" />
            <span>Painel administrativo</span>
          </div>
          <nav aria-label="Módulos" className="admin-side__nav">
            {navItems('side')}
          </nav>
          <div className="admin-side__foot">
            <button type="button" className="btn btn--secondary admin-side__store" onClick={openStore}>
              <Icon name="storefront" size={22} />
              Ver loja
            </button>
            {auth ? (
              <>
                <div className="admin-side__demo">
                  <strong>Ambiente de desenvolvimento.</strong> Acesso autenticado; os dados ainda são demonstrativos.
                  {signedInEmail && <span className="admin-side__user">{signedInEmail}</span>}
                </div>
                <button type="button" className="btn btn--secondary admin-side__store" onClick={() => void auth.signOut()}>
                  <Icon name="logout" size={22} />
                  Sair
                </button>
              </>
            ) : (
              <div className="admin-side__demo">
                <strong>Modo demonstração.</strong> Acesso sem login. Na versão final, o painel será protegido por autenticação.
              </div>
            )}
          </div>
        </aside>

        <div className="admin-main">
          <header className="admin-header">
            <div className="admin-header__bar">
              <img className="admin-header__logo" src={asset('assets/logo.png')} alt="Mundo das Patas" />
              <h1 className="admin-header__title">{tab.label}</h1>
              <span className="admin-header__demo">{auth ? 'Desenvolvimento · dados locais' : 'Demonstração · sem login'}</span>
              <button type="button" className="btn btn--secondary admin-header__store" onClick={openStore} aria-label="Ver loja">
                <Icon name="storefront" size={22} />
                <span className="admin-header__store-label">Ver loja</span>
              </button>
              {auth && (
                <button type="button" className="btn btn--secondary admin-header__logout" onClick={() => void auth.signOut()} aria-label="Sair">
                  <Icon name="logout" size={22} />
                  <span className="admin-header__store-label">Sair</span>
                </button>
              )}
              <button type="button" className="btn btn--primary admin-header__sale" onClick={ui.openSale} style={{ padding: '0 16px' }}>
                <Icon name="point_of_sale" />
                Registrar venda
              </button>
            </div>
            <nav aria-label="Módulos" className="admin-chipnav">
              {navItems('chips')}
            </nav>
          </header>

          <main className="admin-content">
            {auth && (
              <p className="notice notice--warn admin-dev-notice" role="note">
                <strong>Ambiente de desenvolvimento</strong> — dados demonstrativos armazenados neste navegador.
              </p>
            )}
            {(storageFail || !persistent) && (
              <div role="alert" className="alert alert--danger" style={{ padding: '12px 14px', borderRadius: 12 }}>
                {persistent
                  ? 'Não foi possível salvar no armazenamento do navegador (espaço insuficiente). As alterações valem até recarregar a página. Remova imagens grandes ou restaure os dados de demonstração.'
                  : 'Este navegador bloqueou o armazenamento local (ex.: navegação privada). As alterações valem apenas até recarregar a página.'}
              </div>
            )}
            <Outlet />
          </main>
        </div>

        {modal?.kind === 'product' && <ProductFormModal product={modal.product} onClose={close} />}
        {modal?.kind === 'stock' && <StockMoveModal productId={modal.productId} initialType={modal.type} onClose={close} />}
        {modal?.kind === 'sale' && <SaleModal onClose={close} />}
        {modal?.kind === 'category' && <CategoryFormModal category={modal.category} onClose={close} />}
        <ProductDetailModal adminPreview />
      </div>
    </AdminUiContext.Provider>
  );
}
