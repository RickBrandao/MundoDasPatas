import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createCartStorage } from '../services/cartStorage';
import { createLocalStoreApi, STORE_KEY } from '../services/localStoreApi';
import { createMemoryStorage, type KeyValueStorage } from '../services/storage';
import { App } from './App';

function renderApp(hash = '#/', storage: KeyValueStorage = createMemoryStorage()) {
  window.location.hash = hash;
  const utils = render(<App api={createLocalStoreApi({ storage })} cartStorage={createCartStorage(storage)} adminAccess={{ mode: 'demo' }} />);
  return { ...utils, storage, user: userEvent.setup() };
}

const stored = (storage: KeyValueStorage) => JSON.parse(storage.getItem(STORE_KEY)!).data;
const stockOf = (storage: KeyValueStorage, id: string) => stored(storage).products.find((p: { id: string }) => p.id === id).stock;

describe('loja pública', () => {
  it('cliques rápidos seguidos não perdem itens da encomenda', async () => {
    renderApp();
    await screen.findByText('18 produtos');
    const add = within(document.getElementById('produtos')!).getAllByRole('button', { name: /Adicionar/ });
    act(() => {
      fireEvent.click(add[0]);
      fireEvent.click(add[1]);
      fireEvent.click(add[1]);
    });
    expect(await screen.findByRole('button', { name: 'Abrir encomenda (3 itens)' })).toBeInTheDocument();
  });

  it('catálogo, busca, encomenda e prévia do WhatsApp sem registrar venda', async () => {
    const { user, storage } = renderApp();
    expect(await screen.findByRole('heading', { name: /Tudo para o bem-estar/ })).toBeInTheDocument();
    expect(screen.getByText('18 produtos')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Buscar produtos' }), 'bola');
    expect(screen.getByText('1 produto')).toBeInTheDocument();
    const catalog = document.getElementById('produtos')!;
    await user.click(within(catalog).getByRole('button', { name: /Adicionar/ }));
    expect(await screen.findByText('“Bola de Borracha Maciça” adicionado à encomenda.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Abrir encomenda (1 item)' }));
    const drawer = screen.getByRole('dialog', { name: 'Sua encomenda' });
    await user.click(within(drawer).getByRole('button', { name: 'Aumentar quantidade' }));
    await user.click(within(drawer).getByRole('button', { name: 'Aumentar quantidade' }));
    expect(within(drawer).getByText('3 itens')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Encomendar pelo WhatsApp' }));
    const wa = screen.getByRole('dialog', { name: 'Encomendar pelo WhatsApp' });
    const text = within(wa).getByRole('textbox', { name: 'Mensagem' }) as HTMLTextAreaElement;
    expect(text.value).toContain('- Bola de Borracha Maciça — 3 unidades');
    await user.type(text, ' Retiro amanhã.');
    await user.click(within(wa).getByRole('button', { name: /Visualizar envio/ }));
    const url = within(wa).getByLabelText('Link de envio').textContent!;
    expect(url.startsWith('https://wa.me/5511900000000?text=')).toBe(true);
    expect(decodeURIComponent(url.split('?text=')[1])).toContain('Retiro amanhã.');
    expect(within(wa).getByText(/nenhuma mensagem foi enviada/)).toBeInTheDocument();

    await user.click(within(wa).getByRole('button', { name: 'Concluir simulação' }));
    expect(stored(storage).sales).toHaveLength(6);
    expect(stockOf(storage, 'p10')).toBe(27);
  });

  it('produto esgotado não pode ser adicionado', async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes de Ração NutriPata Filhotes 3 kg' }));
    const detail = screen.getByRole('dialog', { name: 'Ração NutriPata Filhotes 3 kg' });
    expect(within(detail).getByText(/Indisponível no momento/)).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Adicionar à encomenda' })).toBeNull();
  });

  it('encomenda persiste após recarregar a página', async () => {
    const storage = createMemoryStorage();
    const first = renderApp('#/', storage);
    await first.user.click((await screen.findAllByRole('button', { name: 'Ver detalhes de Guia Retrátil 5 m' }))[0]);
    await first.user.click(screen.getByRole('button', { name: 'Aumentar' }));
    await first.user.click(screen.getByRole('button', { name: 'Adicionar à encomenda' }));
    first.unmount();

    renderApp('#/', storage);
    expect(await screen.findByRole('button', { name: 'Abrir encomenda (2 itens)' })).toBeInTheDocument();
  });
});

describe('painel administrativo', () => {
  it('navegação entre módulos e retorno à loja', async () => {
    const { user } = renderApp('#/admin');
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
    const nav = screen.getAllByRole('navigation', { name: 'Módulos' })[0];
    await user.click(within(nav).getByRole('link', { name: /Estoque/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Estoque' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/admin/estoque');
    expect(within(nav).getByRole('link', { name: /Estoque/ })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: /Configurações/ }));
    expect(window.location.hash).toBe('#/admin/configuracoes');
    await user.click(screen.getAllByRole('button', { name: 'Ver loja' })[0]);
    expect(await screen.findByRole('heading', { name: /Tudo para o bem-estar/ })).toBeInTheDocument();
  });

  it('registra venda (reduz estoque) e cancela com estorno único', async () => {
    const { user, storage } = renderApp('#/admin/vendas');
    expect(await screen.findByRole('heading', { level: 1, name: 'Vendas' })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Registrar venda/ })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Registrar venda' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Produto' }), 'p6');
    const qty = within(dialog).getByRole('textbox', { name: 'Qtd.' });
    await user.clear(qty);
    await user.type(qty, '21');
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Estoque insuficiente: 20 un.');

    await user.clear(qty);
    await user.type(qty, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar venda' }));
    expect(await screen.findByText('Venda V-0007 registrada. Estoque atualizado.')).toBeInTheDocument();
    expect(stockOf(storage, 'p6')).toBe(18);

    const card = screen.getByText('V-0007').closest('.sale-card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Cancelar e estornar' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar e estornar' }));
    expect(await screen.findByText('Venda V-0007 cancelada. Estoque estornado.')).toBeInTheDocument();
    expect(stockOf(storage, 'p6')).toBe(20);
    expect(within(card).getByText('Cancelada')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Cancelar e estornar' })).toBeNull();
    expect(stored(storage).movements.filter((m: { type: string }) => m.type === 'estorno')).toHaveLength(1);
  });

  it('cadastra e edita produto com preço brasileiro', async () => {
    const { user, storage } = renderApp('#/admin/produtos');
    await user.click(await screen.findByRole('button', { name: 'Novo produto' }));
    let form = screen.getByRole('dialog', { name: 'Novo produto' });
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(within(form).getByText('Informe o nome do produto (mínimo 3 caracteres).')).toBeInTheDocument();

    await user.type(within(form).getByRole('textbox', { name: 'Nome do produto *' }), 'Produto Teste QA');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Categoria *' }), 'brinquedos');
    await user.type(within(form).getByRole('textbox', { name: 'Preço (R$)' }), '1.234,56');
    const stock = within(form).getByRole('textbox', { name: 'Quantidade inicial em estoque' });
    await user.clear(stock);
    await user.type(stock, '5');
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado e publicado no catálogo.')).toBeInTheDocument();
    expect(stored(storage).products[0]).toMatchObject({ name: 'Produto Teste QA', priceCents: 123456, stock: 5 });

    await user.click(screen.getAllByRole('button', { name: 'Produto Teste QA' })[0]);
    form = screen.getByRole('dialog', { name: 'Editar produto' });
    expect(within(form).getByRole('textbox', { name: 'Preço (R$)' })).toHaveValue('1.234,56');
    expect(within(form).getByText('5 un. em estoque')).toBeInTheDocument();
  });

  it('ocultar produto no painel tira o item da encomenda', async () => {
    const storage = createMemoryStorage();
    createCartStorage(storage).save({ p10: 2, p1: 1 });
    const { user } = renderApp('#/admin/produtos', storage);
    const row = (await screen.findByRole('button', { name: 'Bola de Borracha Maciça' })).closest('.admin-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Ocultar/ }));
    await waitFor(() => expect(JSON.parse(storage.getItem('mdp-react-cart-v1')!)).toEqual({ p1: 1 }));
  });

  it('estoque: ajuste negativo é rejeitado e entrada atualiza', async () => {
    const { user, storage } = renderApp('#/admin/estoque');
    await user.click(await screen.findByRole('button', { name: 'Histórico de Ração NutriPata Filhotes 3 kg' }));
    const row = screen.getByText('Ração NutriPata Filhotes 3 kg', { selector: '.stock-row__name' }).closest('.admin-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Ajuste/ }));
    let dialog = screen.getByRole('dialog', { name: 'Movimentar estoque' });
    await user.type(within(dialog).getByRole('textbox', { name: /Nova quantidade/ }), '-3');
    await user.type(within(dialog).getByRole('textbox', { name: 'Motivo ou observação' }), 'teste');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Informe um número inteiro.');
    await user.click(within(dialog).getByRole('button', { name: 'Entrada' }));
    const q = within(dialog).getByRole('textbox', { name: 'Quantidade recebida' });
    await user.clear(q);
    await user.type(q, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('Estoque atualizado: Ração NutriPata Filhotes 3 kg agora tem 5 un.')).toBeInTheDocument();
    expect(stockOf(storage, 'p3')).toBe(5);
    dialog = screen.queryByRole('dialog', { name: 'Movimentar estoque' })!;
    expect(dialog).toBeNull();
  });

  it('configurações: WhatsApp inválido é rejeitado; restaurar demonstração', async () => {
    const { user, storage } = renderApp('#/admin/configuracoes');
    const phone = await screen.findByRole('textbox', { name: /WhatsApp comercial/ });
    await user.clear(phone);
    await user.type(phone, '123');
    await user.click(screen.getByRole('button', { name: 'Salvar configurações' }));
    expect(await screen.findByText('Informe DDD + número (10 ou 11 dígitos).')).toBeInTheDocument();
    expect(stored(storage).settings.whatsapp).toBe('(11) 90000-0000');

    await user.clear(phone);
    await user.type(phone, '+55 (21) 98888-7777');
    await user.click(screen.getByRole('button', { name: 'Salvar configurações' }));
    await waitFor(() => expect(stored(storage).settings.whatsapp).toBe('+55 (21) 98888-7777'));
    expect(screen.getByText('24 de 24 aprovados')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restaurar dados de demonstração' }));
    await act(async () => {
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restaurar' }));
    });
    await waitFor(() => expect(stored(storage).settings.whatsapp).toBe('(11) 90000-0000'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
  });
});
