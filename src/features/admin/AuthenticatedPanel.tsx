import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import type { AdminAccess } from '../../services/auth/adminAccess';
import { AdminAuthProvider } from '../auth/AdminAuthProvider';
import { AdminGate } from '../auth/AdminGate';
import { LoginPage } from '../auth/LoginPage';
import { AdminStoreProvider } from './AdminStoreProvider';

/**
 * Painel com Firebase + API. Carregado sob demanda: a demonstração nunca baixa o login nem o
 * cliente da API administrativa. Os dados só são pedidos depois de o servidor confirmar o acesso.
 */
export default function AuthenticatedPanel({
  access,
  apiBaseUrl,
  children,
}: {
  access: Extract<AdminAccess, { mode: 'firebase' }>;
  apiBaseUrl: string;
  children: ReactNode;
}) {
  return (
    <AdminAuthProvider access={access}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          path="*"
          element={
            <AdminGate>
              <AdminStoreProvider apiBaseUrl={apiBaseUrl}>{children}</AdminStoreProvider>
            </AdminGate>
          }
        />
      </Routes>
    </AdminAuthProvider>
  );
}
