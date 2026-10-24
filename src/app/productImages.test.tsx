/**
 * TASK 07A — fotos dos produtos no painel real (FastAPI simulado) e independência da demonstração.
 *
 * A compressão no navegador (canvas) não existe no jsdom: `compressForUpload` é substituída por uma
 * versão que devolve um WebP fictício (o algoritmo tem testes próprios em imageUpload.test.ts).
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCartStorage } from '../services/cartStorage';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import { createLocalStoreApi } from '../services/localStoreApi';
import { createMemoryStorage } from '../services/storage';
import { API, createFakeAuth, fakeUser, json } from '../test/fakeAuth';
import { createFakeBackend, type FakeBackend } from '../test/fakeBackend';
import { App } from './App';

const compress = vi.hoisted(() => ({
  forUpload: vi.fn(async (file: File) => new Blob([`webp:${file.name}`], { type: 'image/webp' })),
  local: vi.fn(async () => 'data:image/jpeg;base64,REVNTw=='),
}));
vi.mock('../features/products/imageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/products/imageUpload')>()),
  compressForUpload: compress.forUpload,
  compressImage: compress.local,
}));

const ADMIN = () => fakeUser('admin-uid', 'dono@exemplo.com');
const photo = (name = 'gato.jpg', type = 'image/jpeg') => new File(['bytes-da-foto'], name, { type });
const heading = (name: string) => screen.findByRole('heading', { level: 1, name }, { timeout: 4000 });
const dialog = (name: string) => screen.findByRole('dialog', { name });
const imageCalls = (b: FakeBackend) => b.calls.filter((c) => c.path.endsWith('/image'));
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

let previews = 0;
beforeEach(() => {
  previews = 0;
  compress.forUpload.mockClear();
  compress.local.mockClear();
  // jsdom não implementa URLs de objetos (pré-visualização local da foto escolhida).
  URL.createObjectURL = vi.fn(() => `blob:preview-${++previews}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel(hash = '#/admin/produtos') {
  window.location.hash = hash;
  const auth = createFakeAuth({ initialUser: ADMIN(), accounts: { 'dono@exemplo.com': { password: 'x', user: ADMIN() } } });
  render(
    <App
      api={createPublicStoreApi(API)}
      cartStorage={createCartStorage(createMemoryStorage())}
      adminAccess={auth.access}
      dataSource={{ kind: 'api', apiBaseUrl: API }}
    />,
  );
  return { user: userEvent.setup(), auth };
}

function seed(backend: FakeBackend, imageUrl = '') {
  const cat = backend.seedCategory('Rações');
  const p = backend.seedProduct({ categoryId: cat.id, name: 'Ração Foto', imageUrl });
  return { cat, p };
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  expect(await heading('Produtos')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Novo produto' }));
  const form = await dialog('Novo produto');
  await within(form).findByText('Escolher imagem');
  await user.type(within(form).getByLabelText('Nome do produto *'), 'Ração Com Foto');
  await user.type(within(form).getByLabelText('Preço (R$)'), '19,90');
  return form;
}

const fileInput = (form: HTMLElement) => form.querySelector('input[type="file"]') as HTMLInputElement;

describe('painel real com Storage disponível', () => {
  it('produto novo com foto: cadastra, depois envia (ID definitivo), exibe no painel e na vitrine sem login', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    backend.seedCategory('Rações');
    const { user } = renderPanel();
    const form = await openNew(user);

    await user.upload(fileInput(form), photo());
    expect(compress.forUpload).toHaveBeenCalledWith(expect.any(File), 2 * 1024 * 1024);
    expect(within(form).getByRole('img', { name: 'Pré-visualização da nova foto' })).toHaveAttribute('src', 'blob:preview-1');
    expect(within(form).getByText('Nova foto pronta: será enviada ao salvar o produto.')).toBeInTheDocument();
    expect(imageCalls(backend)).toHaveLength(0); // nada sai antes de salvar

    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado e publicado no catálogo.')).toBeInTheDocument();

    const writes = backend.writes().map((c) => `${c.method} ${c.path.replace(/[0-9a-f]{32}/, ':id')}`);
    expect(writes).toEqual(['POST /api/v1/admin/products', 'PUT /api/v1/admin/products/:id/image']);
    const created = backend.db.products[0];
    expect(backend.writes()[0].body).not.toHaveProperty('imageUrl'); // nada de data URL/Base64 no cadastro
    expect(imageCalls(backend)[0].path).toBe(`/api/v1/admin/products/${created.id}/image`);
    expect([...backend.db.images.values()]).toEqual([{ productId: created.id, type: 'image/webp', size: expect.any(Number) }]);
    expect(created.imageUrl).toMatch(/^https:\/\/storage\.test\//);

    // Painel exibe a foto salva.
    const row = screen.getByRole('button', { name: 'Ração Com Foto' }).closest('.admin-row')!;
    expect(row.querySelector('img')).toHaveAttribute('src', created.imageUrl);

    // Vitrine aberta por um visitante (sem login): o catálogo público traz a mesma URL.
    cleanup();
    window.location.hash = '#/';
    render(
      <App
        api={createPublicStoreApi(API)}
        cartStorage={createCartStorage(createMemoryStorage())}
        adminAccess={createFakeAuth().access}
        dataSource={{ kind: 'api', apiBaseUrl: API }}
      />,
    );
    const card = await screen.findByRole('button', { name: 'Ver detalhes de Ração Com Foto' });
    expect(card.closest('article')!.querySelector('img')).toHaveAttribute('src', created.imageUrl);
    expect(backend.calls.filter((c) => c.path === '/api/v1/public/catalog').every((c) => c.token === null)).toBe(true);
  });

  it('falha no envio de produto novo: produto salvo, sucesso NÃO anunciado, e nova tentativa não duplica o cadastro', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    backend.seedCategory('Rações');
    const { user } = renderPanel();
    const form = await openNew(user);
    await user.upload(fileInput(form), photo());
    backend.failNext('PUT', '/api/v1/admin/products/', json(503, { error: { code: 'storage_unavailable', message: 'x' } }));
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));

    expect(await screen.findByText('Produto cadastrado, mas a foto não foi enviada.')).toBeInTheDocument();
    expect(screen.queryByText('Produto cadastrado e publicado no catálogo.')).toBeNull();
    const still = await dialog('Editar produto'); // o formulário continua aberto, agora editando o produto criado
    expect(within(still).getByRole('alert')).toHaveTextContent('A foto não foi enviada: O envio de fotos está indisponível no momento.');
    expect(backend.db.products).toHaveLength(1);
    expect(backend.db.products[0].imageUrl).toBe('');

    await user.click(within(still).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(backend.db.products).toHaveLength(1);
    expect(backend.writes().filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(backend.db.products[0].imageUrl).toMatch(/^https:\/\/storage\.test\//);
  });

  it('falha no cadastro: nenhuma foto é enviada', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    backend.seedCategory('Rações');
    const { user } = renderPanel();
    const form = await openNew(user);
    await user.upload(fileInput(form), photo());
    backend.failNext('POST', '/api/v1/admin/products', json(422, { error: { code: 'validation_error', message: 'Categoria inexistente.', fieldErrors: { categoryId: 'Categoria inexistente.' } } }));
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await within(form).findByText('Categoria inexistente.', { selector: '.field-error' })).toBeInTheDocument();
    expect(imageCalls(backend)).toHaveLength(0);
    expect(backend.db.products).toHaveLength(0);
  });

  it('substituição com falha preserva a foto anterior; substituição bem-sucedida troca o arquivo', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    const { p } = seed(backend);
    const { user } = renderPanel();
    expect(await heading('Produtos')).toBeInTheDocument();

    // Primeira foto.
    await user.click(screen.getByRole('button', { name: 'Ração Foto' }));
    let form = await dialog('Editar produto');
    await user.upload(fileInput(await within(form).findByText('Escolher imagem').then(() => form)), photo('a.png', 'image/png'));
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    const first = backend.db.products[0].imageUrl;
    expect(first).toMatch(/^https:/);

    // Troca falha na rede: produto continua com a foto anterior.
    await user.click(screen.getByRole('button', { name: 'Ração Foto' }));
    form = await dialog('Editar produto');
    expect(within(form).getByRole('img', { name: 'Pré-visualização' })).toHaveAttribute('src', first);
    await within(form).findByText('Trocar imagem');
    await user.upload(fileInput(form), photo('b.webp', 'image/webp'));
    backend.failNext('PUT', `/api/v1/admin/products/${p.id}/image`, 'network');
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas, mas a foto não foi enviada.')).toBeInTheDocument();
    expect(backend.db.products[0].imageUrl).toBe(first);
    expect(backend.db.images.size).toBe(1);

    // Nova tentativa: substitui (o servidor remove o arquivo anterior).
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(backend.db.products[0].imageUrl).not.toBe(first);
    expect(backend.db.images.size).toBe(1);
  });

  it('remoção da foto: só acontece ao salvar e volta para a ilustração', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    const { p } = seed(backend, 'https://storage.test/v0/b/bucket/o/products%2Fx?alt=media&token=t');
    const { user } = renderPanel();
    expect(await heading('Produtos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ração Foto' }));
    const form = await dialog('Editar produto');
    await user.click(await within(form).findByRole('button', { name: 'Remover' }));
    expect(within(form).getByText('A foto será removida ao salvar o produto.')).toBeInTheDocument();
    expect(within(form).getByRole('img', { name: 'Pré-visualização' }).getAttribute('src')).toMatch(/assets\/produtos\/cat-/);
    expect(imageCalls(backend)).toHaveLength(0);
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(imageCalls(backend).map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /api/v1/admin/products/${p.id}/image`]);
    expect(backend.db.products[0].imageUrl).toBe('');
  });

  it('arquivo inválido: erro claro no formulário e nada é enviado; erro do servidor aparece junto da foto', async () => {
    const backend = createFakeBackend().install();
    backend.enableImages();
    backend.seedCategory('Rações');
    const { user } = renderPanel();
    const form = await openNew(user);
    compress.forUpload.mockRejectedValueOnce(new Error('A imagem parece corrompida ou não é uma imagem válida. Tente outro arquivo.'));
    await user.upload(fileInput(form), photo('falsa.jpg'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('A imagem parece corrompida');
    expect(backend.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);

    await user.upload(fileInput(form), photo('ok.jpg'));
    backend.failNext(
      'PUT',
      '/api/v1/admin/products/',
      json(422, { error: { code: 'invalid_image', message: 'x', fieldErrors: { image: 'O conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WebP válida.' } } }),
    );
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado, mas a foto não foi enviada.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('não corresponde a uma imagem JPEG, PNG ou WebP válida');
  });
});

describe('painel real com Storage indisponível', () => {
  it('sem seletor de foto, mensagem clara, produto salvo sem imagem e nenhum fallback local', async () => {
    const backend = createFakeBackend().install();
    backend.seedCategory('Rações');
    const { user } = renderPanel();
    expect(await heading('Produtos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Novo produto' }));
    const form = await dialog('Novo produto');
    expect(await within(form).findByText(/envio de fotos ainda não está disponível neste ambiente/)).toBeInTheDocument();
    expect(within(form).queryByText('Escolher imagem')).toBeNull();
    await user.type(within(form).getByLabelText('Nome do produto *'), 'Sem Foto');
    await user.click(within(form).getByRole('checkbox', { name: 'Exibir preço no catálogo' }));
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado e publicado no catálogo.')).toBeInTheDocument();
    expect(backend.db.products[0].imageUrl).toBe('');
    expect(imageCalls(backend)).toHaveLength(0);
    expect(compress.local).not.toHaveBeenCalled();
  });

  it('foto quebrada na vitrine: mostra a ilustração em vez de imagem quebrada', async () => {
    const backend = createFakeBackend().install();
    seed(backend, 'https://storage.test/removida.webp');
    window.location.hash = '#/';
    render(
      <App
        api={createPublicStoreApi(API)}
        cartStorage={createCartStorage(createMemoryStorage())}
        adminAccess={createFakeAuth().access}
        dataSource={{ kind: 'api', apiBaseUrl: API }}
      />,
    );
    const card = await screen.findByRole('button', { name: 'Ver detalhes de Ração Foto' });
    const img = card.closest('article')!.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://storage.test/removida.webp');
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(img.getAttribute('src')).toMatch(/assets\/produtos\/cat-default\.svg$/);
  });
});

describe('fim da sessão durante o envio da foto', () => {
  async function startUpload(backend: FakeBackend, apply: 'before' | 'after') {
    backend.enableImages();
    const { p } = seed(backend);
    const ctx = renderPanel();
    const { user } = ctx;
    expect(await heading('Produtos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ração Foto' }));
    const form = await dialog('Editar produto');
    await within(form).findByText('Escolher imagem');
    await user.upload(fileInput(form), photo());
    const held = backend.hold('PUT', `/api/v1/admin/products/${p.id}/image`, { apply, ignoreAbort: true });
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    await held.arrived;
    expect(within(form).getByRole('status')).toHaveTextContent('Enviando a foto…');
    await user.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Sair mesmo assim' }));
    expect(await heading('Entrar')).toBeInTheDocument();
    expect(held.signal?.aborted).toBe(true);
    return { held, p };
  }

  it('logout durante o envio: requisição abortada, nenhuma mensagem e nenhuma chamada nova', async () => {
    const backend = createFakeBackend().install();
    const { held } = await startUpload(backend, 'before');
    const before = backend.calls.length;
    await act(async () => held.release());
    await pause(50);
    expect(screen.queryByText(/foto não foi enviada|Alterações salvas/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(backend.calls.slice(before).filter((c) => c.path.startsWith('/api/v1/admin/'))).toHaveLength(0);
  });

  it('resposta tardia depois do logout: o servidor pode ter gravado, mas a tela encerrada não reage', async () => {
    const backend = createFakeBackend().install();
    const { held, p } = await startUpload(backend, 'after');
    const before = backend.calls.length;
    await act(async () => held.release());
    await pause(50);
    // O servidor concluiu (a foto está associada); o resultado aparece no próximo acesso, não nesta tela.
    expect(backend.db.products.find((x) => x.id === p.id)?.imageUrl).toMatch(/^https:/);
    expect(screen.queryByText(/Alterações salvas|foto não foi enviada/)).toBeNull();
    expect(backend.calls.slice(before).filter((c) => c.path.startsWith('/api/v1/admin/'))).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
  });
});

describe('demonstração continua independente', () => {
  it('foto local (data URL) sem rede, sem Firebase e sem Storage', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('rede proibida na demonstração');
    });
    vi.stubGlobal('fetch', fetchSpy);
    window.location.hash = '#/admin/produtos';
    const storage = createMemoryStorage();
    render(
      <App
        api={createLocalStoreApi({ storage })}
        cartStorage={createCartStorage(storage)}
        adminAccess={{ mode: 'demo' }}
        dataSource={{ kind: 'local' }}
      />,
    );
    const user = userEvent.setup();
    expect(await heading('Produtos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Novo produto' }));
    const form = await dialog('Novo produto');
    expect(within(form).getByText(/reduzida para 600 px/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Nome do produto *'), 'Demo Foto');
    await user.type(within(form).getByLabelText('Preço (R$)'), '9,90');
    await user.upload(fileInput(form), photo());
    await waitFor(() => expect(within(form).getByRole('img', { name: 'Pré-visualização' })).toHaveAttribute('src', 'data:image/jpeg;base64,REVNTw=='));
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado e publicado no catálogo.')).toBeInTheDocument();
    expect(compress.local).toHaveBeenCalledTimes(1);
    expect(compress.forUpload).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(JSON.parse(storage.getItem('mdp-react-demo-v1')!).data.products)).toContain('data:image/jpeg;base64,REVNTw==');
  });
});
