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
resolvida no build: o pacote da demonstração não contém o cliente HTTP, o login, a API administrativa
nem o chunk `AuthenticatedPanel` (eliminado na TASK 06E); o pacote real não contém os dados fictícios.

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
- **Imagens:** no modo real, a foto é compactada no navegador e enviada ao FastAPI depois de salvar o
  produto (Cloud Storage, TASK 07A — ver [`storage.md`](storage.md)); data URLs nunca são enviadas; sem
  foto (ou se a imagem falhar ao carregar) usa a ilustração padrão da categoria.
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

Um único comando (Windows PowerShell, Linux ou macOS), sem credenciais Google reais:

```powershell
npm run test:e2e:emulator            # emuladores + FastAPI + smoke React → API → Firestore Emulator
npm run test:integration:emulator    # idem, rodando antes os 32 testes do backend no emulador
npm run test:e2e:emulator -- --keep-logs   # mantém a pasta de logs
```

`scripts/e2e-emulator.mjs`:

1. confere Firebase CLI, Java e o Python de `backend/.venv` (executados sem shell);
2. escolhe portas livres a partir de 8181/9150/9099/4400/4500/8010 — porta ocupada por outro programa é
   mantida e a próxima livre é usada (nenhum processo alheio é encerrado);
3. sobe Firestore + Auth Emulator com uma configuração temporária, projeto `demo-mundo-das-patas-test`;
4. sobe o FastAPI com `cwd` numa pasta temporária (o `backend/.env`, que aponta para o projeto real, não é
   lido), sem `GOOGLE_APPLICATION_CREDENTIALS` e com `CLOUDSDK_CONFIG` vazio (o ADC do usuário não é encontrado);
5. recusa continuar se o projeto não for `demo-*`, se faltar `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST`,
   se apontarem para fora de 127.0.0.1 ou se `/health` não informar `database: emulator`;
6. roda `vitest --config vitest.e2e.config.ts` (o teste também se recusa a rodar fora desse ambiente);
7. encerra a árvore de cada processo iniciado (`taskkill /T` no Windows) e confere que todos saíram e que
   as portas foram liberadas — caso contrário o comando termina com erro.

`npm run test:e2e:run` executa só o Vitest (serviços já no ar, variáveis definidas manualmente).

Navegador contra os emuladores (somente `vite` dev; `VITE_FIREBASE_AUTH_EMULATOR_HOST` é ignorada em builds):

```powershell
$env:VITE_ADMIN_AUTH_MODE="firebase"; $env:VITE_STORE_DATA_SOURCE="api"; $env:VITE_API_BASE_URL="http://127.0.0.1:8010"
$env:VITE_FIREBASE_API_KEY="fake-api-key"; $env:VITE_FIREBASE_AUTH_DOMAIN="demo-mundo-das-patas-test.firebaseapp.com"
$env:VITE_FIREBASE_PROJECT_ID="demo-mundo-das-patas-test"; $env:VITE_FIREBASE_APP_ID="1:000:web:e2e"
$env:VITE_FIREBASE_MESSAGING_SENDER_ID="000"; $env:VITE_FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
npx vite --port 5174
```

## 6. Ciclo de vida da sessão administrativa (TASK 06E)

Cada autorização (`GET /admin/me` = 200) abre um escopo com um `AbortController` novo, entregue ao painel
em `session.signal`. Logout, expiração, revogação (401/403 → reverificação → acesso negado), troca de
usuário, nova verificação não silenciosa e desmontagem do painel **abortam** o escopo. Uma revalidação
silenciosa do mesmo usuário mantém o escopo; um escopo abortado nunca é reutilizado.

Com o escopo abortado:

| Ponto | Comportamento |
| --- | --- |
| Antes do token (`getIdToken`) | nada é pedido |
| Depois do token, antes do fetch | nada é enviado (o SDK não aceita AbortSignal; a sessão é conferida antes e depois) |
| Fetch em andamento | recebe o abort (o sinal da sessão é combinado com o tempo limite, não substituído) |
| Resposta que chega depois | descartada antes de ser lida/aplicada |
| Espera entre tentativas | termina na hora (timer e listener liberados); nenhuma nova tentativa sai |
| Releitura após escrita | não acontece |
| `StoreProvider` | não aplica resultados; o painel é desmontado |
| Toasts / confirmações do painel | mensagens tardias são descartadas; diálogos abertos fecham ("não") |

**Limite — abort não é rollback.** Uma venda que já chegou ao FastAPI e foi confirmada no Firestore
continua registrada; o cliente não tenta desfazer nem compensar nada. Por isso:

- ao clicar em **Sair** com gravação sem resposta, o painel pede confirmação ("pode já ter sido registrada
  no servidor"); a escolha é do usuário e nunca bloqueia indefinidamente;
- se a sessão termina com gravação sem resposta, a tela de login informa que a operação pode ter sido
  concluída e deve ser conferida em Vendas/Estoque no próximo acesso;
- no próximo acesso tudo é relido do servidor; a idempotência (chave por intenção, 24 h) segue valendo
  para novas tentativas da mesma operação no mesmo painel aberto.

Não há revogação global de tokens no logout (afetaria outras sessões do mesmo usuário e não desfaria nada).

## 7. Pendências

- Fotos no Storage real: exige o plano Blaze e o bucket do projeto Dev ([`storage.md`](storage.md) §7).
- Histórico além das 500 vendas/movimentações mais recentes (paginação).
- Teste funcional com dados no Firestore real do projeto Dev: depende de login do proprietário e de
  aprovação para gravar dados de teste (ver relatório da TASK 06C).
