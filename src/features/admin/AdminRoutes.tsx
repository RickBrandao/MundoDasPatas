import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAdminAccess, useDataSource } from '../../app/contexts';
import { panelProblems } from '../../services/dataSource';
import '../../styles/admin.css';
import { AuthShell } from '../auth/AuthShell';
import { CategoriesPage } from '../categories/CategoriesPage';
import { StockPage } from '../inventory/StockPage';
import { ProductsPage } from '../products/ProductsPage';
import { SalesPage } from '../sales/SalesPage';
import { SettingsPage } from '../settings/SettingsPage';
import { AdminLayout } from './AdminLayout';
import { OverviewPage } from './OverviewPage';

// Login, sessão e cliente da API administrativa: só baixados no modo Firebase + API.
const AuthenticatedPanel = lazy(() => import('./AuthenticatedPanel'));

function PanelRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="/admin/visao-geral" replace />} />
        <Route path="visao-geral" element={<OverviewPage />} />
        <Route path="produtos" element={<ProductsPage />} />
        <Route path="categorias" element={<CategoriesPage />} />
        <Route path="estoque" element={<StockPage />} />
        <Route path="vendas" element={<SalesPage />} />
        <Route path="configuracoes" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/admin/visao-geral" replace />} />
      </Route>
    </Routes>
  );
}

export default function AdminRoutes() {
  const access = useAdminAccess();
  const source = useDataSource();

  // Configuração inválida (autenticação ou origem dos dados): bloqueia — nunca cai para a demonstração.
  const problems = access.mode === 'misconfigured' ? access.problems : panelProblems(access.mode, source);
  if (access.mode === 'misconfigured' || problems.length > 0) {
    return (
      <AuthShell title="Painel indisponível">
        <div role="alert" className="alert alert--danger">
          A autenticação ou a origem dos dados do painel não está configurada corretamente neste ambiente. O acesso permanece bloqueado.
        </div>
        <ul className="auth-card__problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </AuthShell>
    );
  }

  // Demonstração (GitHub Pages): painel aberto com dados locais, como aprovado pelo cliente.
  if (access.mode === 'demo' || source.kind !== 'api') return <PanelRoutes />;

  // Firebase + API: dados administrativos só depois de o servidor confirmar o acesso (AdminGate).
  return (
    <Suspense fallback={<div className="app-loading">Carregando painel…</div>}>
      <AuthenticatedPanel access={access} apiBaseUrl={source.apiBaseUrl}>
        <PanelRoutes />
      </AuthenticatedPanel>
    </Suspense>
  );
}
