import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { CartDrawer } from '../features/cart/CartDrawer';
import { CartProvider } from '../features/cart/CartProvider';
import { WhatsAppModal } from '../features/cart/WhatsAppModal';
import { ProductDetailModal } from '../features/catalog/ProductDetailModal';
import { StorePage } from '../features/catalog/StorePage';
import type { CartStorage } from '../services/cartStorage';
import type { StoreApi } from '../services/storeApi';
import { FeedbackProvider } from './FeedbackProvider';
import { StoreProvider } from './StoreProvider';
import { UiProvider } from './UiProvider';

// O painel é carregado sob demanda: visitantes da loja não baixam o código administrativo.
const AdminRoutes = lazy(() => import('../features/admin/AdminRoutes'));

function PublicArea() {
  return (
    <>
      <StorePage />
      <CartDrawer />
      <ProductDetailModal adminPreview={false} />
      <WhatsAppModal />
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<PublicArea />} />
      <Route
        path="/admin/*"
        element={
          <Suspense fallback={<div className="app-loading">Carregando painel…</div>}>
            <AdminRoutes />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Provedores compartilhados (também usados nos testes de integração, com serviços falsos). */
export function AppProviders({ api, cartStorage, children }: { api: StoreApi; cartStorage: CartStorage; children: React.ReactNode }) {
  return (
    <FeedbackProvider>
      <StoreProvider api={api}>
        <UiProvider>
          <CartProvider storage={cartStorage}>{children}</CartProvider>
        </UiProvider>
      </StoreProvider>
    </FeedbackProvider>
  );
}

export function App({ api, cartStorage }: { api: StoreApi; cartStorage: CartStorage }) {
  return (
    <HashRouter>
      <AppProviders api={api} cartStorage={cartStorage}>
        <AppRoutes />
      </AppProviders>
    </HashRouter>
  );
}
