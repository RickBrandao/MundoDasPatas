# Integração React + FastAPI + Firestore (TASK 06C)

## 1. Modos de operação

| `VITE_ADMIN_AUTH_MODE` | `VITE_STORE_DATA_SOURCE` | Resultado |
| --- | --- | --- |
| `demo` (padrão) | `local` (padrão) | **Demonstração** (GitHub Pages): dados fictícios no navegador, painel sem login, nenhuma chamada HTTP |
| `firebase` | `api` | **Real (desenvolvimento)**: catálogo pela API pública, painel com Firebase Authentication + API administrativa, dados no Firestore |
| `demo` | `api` | Catálogo pela API; **painel bloqueado** (dados reais nunca ficam sem login) |
| `firebase` | `local` | **Painel bloqueado** (dados reais nunca ficam no navegador) |
| qualquer valor inválido | | Bloqueado; nunca cai para a demonstração |

Falha da API ou do Firestore mostra erro com "Tentar novamente" — nunca troca para os dados locais.
O carrinho de encomendas continua no navegador (nos dois modos).

O workflow do GitHub Pages fixa `VITE_ADMIN_AUTH_MODE=demo` e `VITE_STORE_DATA_SOURCE=local`. A escolha é
resolvida no build: o pacote da demonstração não contém o cliente HTTP, o login nem a API administrativa
(o chunk `AuthenticatedPanel` existe, mas nunca é baixado); o pacote real não contém os dados fictícios.

## 2. Arquitetura no frontend

```
StoreProvider (raiz)  ── api pública: createPublicStoreApi ── GET /api/v1/public/catalog   (sem token)
  └─ /admin/*  AuthenticatedPanel (lazy)
       AdminAuthProvider → AdminGate (GET /api/v1/admin/me)
         └─ AdminStoreProvider → StoreProvider(createAdminStoreApi) ── /api/v1/admin/* (Bearer)
```

- A vitrine nunca chama rotas administrativas; o painel só monta `AdminStoreProvider` depois de
  `/admin/me` confirmar o UID. Logout ou troca de usuário desmonta o provedor (os dados saem da memória).
- Os componentes continuam usando `useStore()`; dentro do painel o contexto é o administrativo.
- 401/403 durante o uso reconfirma a sessão (no máximo uma vez a cada 30 s).

| Módulo | Papel |
| --- | --- |
| `src/services/dataSource.ts` | `VITE_STORE_DATA_SOURCE` e combinações permitidas |
| `src/services/http/apiClient.ts` | `requestJson`: tempo limite, cancelamento, erros `{error:{code,message,fieldErrors}}` → mensagens seguras |
| `src/services/http/adapters.ts` | DTO ⇄ domínio (ISO 8601 → ms, centavos, validação de formato, `minStock` público) |
| `src/services/http/publicStoreApi.ts` | catálogo público, somente leitura |
| `src/services/http/adminStoreApi.ts` | painel: leituras, escritas, idempotência, releitura após cada escrita |
| `src/services/http/idempotency.ts`, `src/app/useIdempotencyKeys.ts` | chave por intenção do usuário |
| `src/services/auth/adminHttp.ts` | (existente) token, `Authorization: Bearer`, renovação em 401, `no-store` |

## 3. Regras implementadas

- **Servidor como autoridade:** depois de cada escrita confirmada o painel relê produtos, categorias,
  vendas, movimentações (500 mais recentes), configurações e dashboard. Se só a releitura falhar,
  aplica a resposta da escrita e mostra "listas possivelmente desatualizadas" com botão Atualizar.
- **Idempotência:** venda, movimentação e cancelamento enviam `Idempotency-Key` (UUID). A chave é
  derivada da intenção (itens da venda; produto+tipo+quantidade+motivo; ID da venda) e reaproveitada
  em toda nova tentativa — automática (rede, tempo limite, 503 `database_busy`; até 2 repetições) ou
  manual (o usuário clica de novo depois do erro). Nova chave só após sucesso ou com outro conteúdo.
- **Sem repetição automática** em cadastros e edições; resultado desconhecido avisa para conferir a lista
  (que é relida).
- **Duplo clique:** botões desabilitados durante a gravação (venda, estoque, produto, categoria, configurações).
- **Erros:** 400/404/409/422 usam a mensagem do servidor (regras de negócio em português); 401/403/5xx usam
  mensagens fixas; detalhes de 500 nunca aparecem. `fieldErrors` vão aos campos (`priceCents` → `price`);
  mensagens do Pydantic viram "Valor inválido." / "Texto muito curto."
- **Imagens:** sem upload no modo real (aviso no formulário); data URLs nunca são enviadas; vazio usa a
  ilustração padrão da categoria. Upload no Cloud Storage fica para uma task futura.
- **Banco vazio:** catálogo vazio sem erro, painel zerado, avisos para cadastrar a primeira categoria.
  Nada é gravado só por abrir páginas (configurações padrão não são persistidas implicitamente).
- **WhatsApp:** abrir/preparar a mensagem não cria venda nem altera estoque.
- **Dashboard:** indicadores de `GET /admin/dashboard`; "mais vendidos" usa as vendas carregadas.

## 4. Executar localmente (dados reais do projeto Dev)

`backend/.env`: `DATA_BACKEND=firestore`, `FIREBASE_PROJECT_ID=mundo-das-patas---dev`, `ADMIN_ALLOWED_UIDS=...`.
`.env.local`: `VITE_ADMIN_AUTH_MODE=firebase`, `VITE_STORE_DATA_SOURCE=api`, `VITE_API_BASE_URL=http://127.0.0.1:8000`.

```powershell
# backend (sem a credencial global do SPA Conceito, só neste processo)
cd backend
Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
# frontend (outro terminal, na raiz)
npm run dev   # http://localhost:5173/MundoDasPatas/
```

## 5. Testes de ponta a ponta com o Firebase Emulator Suite

Projeto fictício `demo-mundo-das-patas-test` (projetos `demo-*` não existem na nuvem). Nenhuma credencial real.

```powershell
firebase emulators:start --only firestore,auth --project demo-mundo-das-patas-test   # 8181 e 9099

# API ligada só aos emuladores (porta 8010)
cd backend
$env:APP_ENV="local"; $env:DATA_BACKEND="firestore"; $env:FIREBASE_PROJECT_ID="demo-mundo-das-patas-test"
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8181"; $env:FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
$env:ADMIN_ALLOWED_UIDS="e2e-admin-uid"; $env:CORS_ORIGINS="http://localhost:5174"
.\.venv\Scripts\python -m uvicorn app.main:app --port 8010

# Smoke test (camada de dados do React → API → emulador), na raiz:
npm run test:e2e:emulator
```

O smoke test aborta antes de gravar se o projeto não for `demo-*` ou se `/health` não informar
`database: emulator`, apaga os dados do emulador, cria os usuários de teste no Auth Emulator e confere
os documentos diretamente no emulador.

Navegador contra os emuladores (somente `vite` dev; `VITE_FIREBASE_AUTH_EMULATOR_HOST` é ignorada em builds):

```powershell
$env:VITE_ADMIN_AUTH_MODE="firebase"; $env:VITE_STORE_DATA_SOURCE="api"; $env:VITE_API_BASE_URL="http://127.0.0.1:8010"
$env:VITE_FIREBASE_API_KEY="fake-api-key"; $env:VITE_FIREBASE_AUTH_DOMAIN="demo-mundo-das-patas-test.firebaseapp.com"
$env:VITE_FIREBASE_PROJECT_ID="demo-mundo-das-patas-test"; $env:VITE_FIREBASE_APP_ID="1:000:web:e2e"
$env:VITE_FIREBASE_MESSAGING_SENDER_ID="000"; $env:VITE_FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
npx vite --port 5174   # login: admin@e2e.test (usuário criado pelo smoke test no emulador)
```

## 6. Pendências

- Upload de imagens (Cloud Storage).
- Histórico além das 500 vendas/movimentações mais recentes (paginação).
- Teste funcional com dados no Firestore real do projeto Dev: depende de login do proprietário e de
  aprovação para gravar dados de teste (ver relatório da TASK 06C).
