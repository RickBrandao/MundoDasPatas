import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { createCartStorage } from '../../services/cartStorage';
import { createLocalStoreApi } from '../../services/localStoreApi';
import { createMemoryStorage } from '../../services/storage';

// Se algum módulo da demonstração importar o SDK, a fábrica roda e o teste acusa.
const imported = vi.hoisted(() => ({ app: false, auth: false }));
vi.mock('firebase/app', () => {
  imported.app = true;
  return {};
});
vi.mock('firebase/auth', () => {
  imported.auth = true;
  return {};
});

function renderDemo(hash: string) {
  window.location.hash = hash;
  const storage = createMemoryStorage();
  render(<App api={createLocalStoreApi({ storage })} cartStorage={createCartStorage(storage)} adminAccess={{ mode: 'demo' }} />);
  return userEvent.setup();
}

describe('modo demonstração (GitHub Pages)', () => {
  it('painel abre sem login, com os avisos de demonstração e sem botão Sair', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDemo('#/admin/visao-geral');
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
    expect(screen.getByText('Demonstração · sem login')).toBeInTheDocument();
    expect(screen.getByText(/Acesso sem login/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sair' })).toBeNull();
    expect(screen.queryByText(/Ambiente de desenvolvimento/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('não existe tela de login: a rota leva ao painel', async () => {
    renderDemo('#/admin/login');
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Senha')).toBeNull();
  });

  it('loja pública da demonstração usa os dados fictícios locais, sem chamar a API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDemo('#/');
    expect(await screen.findByText('18 produtos')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('loja mantém o atalho "Painel (demo)" e o Firebase nunca é carregado', async () => {
    const user = renderDemo('#/');
    await user.click(await screen.findByRole('button', { name: 'Painel (demo)' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
    expect(imported).toEqual({ app: false, auth: false });
  });
});
