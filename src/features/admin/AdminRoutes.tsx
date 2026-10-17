import { Navigate, Route, Routes } from 'react-router-dom';
import '../../styles/admin.css';
import { CategoriesPage } from '../categories/CategoriesPage';
import { StockPage } from '../inventory/StockPage';
import { ProductsPage } from '../products/ProductsPage';
import { SalesPage } from '../sales/SalesPage';
import { SettingsPage } from '../settings/SettingsPage';
import { AdminLayout } from './AdminLayout';
import { OverviewPage } from './OverviewPage';

export default function AdminRoutes() {
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
