import { Navigate, Route, Routes } from 'react-router-dom';
import { useAdminAccess } from '../../app/contexts';
import '../../styles/admin.css';
import { AdminAuthProvider } from '../auth/AdminAuthProvider';
import { AdminGate } from '../auth/AdminGate';
import { AuthShell } from '../auth/AuthShell';
import { LoginPage } from '../auth/LoginPage';
import { CategoriesPage } from '../categories/CategoriesPage';
import { StockPage } from '../inventory/StockPage';
import { ProductsPage } from '../products/ProductsPage';
import { SalesPage } from '../sales/SalesPage';
import { SettingsPage } from '../settings/SettingsPage';
import { AdminLayout } from './AdminLayout';
import { OverviewPage } from './OverviewPage';

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

  // Demonstração (GitHub Pages): painel aberto, como aprovado pelo cliente.
  if (access.mode === 'demo') return <PanelRoutes />;

  // Configuração inválida no modo autenticado: bloqueia (nunca cai para a demonstração).
  if (access.mode === 'misconfigured') {
    return (
      <AuthShell title="Painel indisponível">
        <div role="alert" className="alert alert--danger">
          A autenticação do painel não está configurada corretamente neste ambiente. O acesso permanece bloqueado.
        </div>
        <ul className="auth-card__problems">
          {access.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </AuthShell>
    );
  }

  return (
    <AdminAuthProvider access={access}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          path="*"
          element={
            <AdminGate>
              <PanelRoutes />
            </AdminGate>
          }
        />
      </Routes>
    </AdminAuthProvider>
  );
}
