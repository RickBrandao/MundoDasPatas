# Mundo das Patas — Backend (FastAPI)

Fundação da API real do Mundo das Patas (TASK 04). Desde a TASK 06C o frontend React consome esta API
com `VITE_STORE_DATA_SOURCE=api` + `VITE_ADMIN_AUTH_MODE=firebase` (guia: [`docs/integracao-api.md`](../docs/integracao-api.md));
a demonstração do GitHub Pages continua com os dados fictícios do navegador (`localStoreApi`).

> **Situação:** arquitetura, contratos, segurança e regras de negócio prontos e testados.
> **Persistência no Cloud Firestore implementada** (TASK 06B) e validada no Firestore Emulator —
> guia completo em [`docs/firestore.md`](../docs/firestore.md). O banco real ainda não recebeu
> escritas (smoke test pendente de aprovação). O login do painel (TASK 05B) usa `GET /api/v1/admin/me`
> — ver [`docs/autenticacao.md`](../docs/autenticacao.md).
> Os repositórios em memória servem apenas para testes e desenvolvimento local.

## Sumário

1. [Execução local (Windows PowerShell)](#1-execução-local-windows-powershell)
2. [Arquitetura](#2-arquitetura)
3. [Endpoints](#3-endpoints)
4. [Contratos e serialização](#4-contratos-e-serialização)
5. [Segurança](#5-segurança)
6. [Persistência, transações e idempotência](#6-persistência-transações-e-idempotência)
7. [Configuração (variáveis de ambiente)](#7-configuração-variáveis-de-ambiente)
8. [Configurar o Firebase (próximas etapas)](#8-configurar-o-firebase-próximas-etapas)
9. [Hospedagem futura na Vercel](#9-hospedagem-futura-na-vercel)
10. [Auditoria do frontend e plano de integração React → API](#10-auditoria-do-frontend-e-plano-de-integração-react--api)
11. [Pendências](#11-pendências)

---

## 1. Execução local (Windows PowerShell)

**Python:** 3.13 (mínimo 3.12). A especificação sugeria 3.12; o código usa recursos de 3.12
(genéricos PEP 695) e foi testado em 3.13.10 — versão estável, com correções de segurança até 2029
e suportada por FastAPI, Pydantic e firebase-admin. 3.12 não está instalado nesta máquina; a
versão disponível no runtime Python da Vercel deve ser confirmada na task de deploy (3.12 também serve).
O arquivo `.python-version` registra a versão usada.

```powershell
cd backend
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1          # se bloqueado: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env           # opcional; sem .env valem os padrões de desenvolvimento

uvicorn app.main:app --reload --port 8000
```

- API: <http://127.0.0.1:8000>
- Health check: <http://127.0.0.1:8000/health>
- Swagger (OpenAPI): <http://127.0.0.1:8000/docs> (desativado quando `APP_ENV=production`)

Não é preciso nenhuma credencial do Firebase para iniciar a aplicação, ver o health check e
consultar a API pública. As rotas administrativas continuam protegidas: sem token respondem
`401`, e com token mas sem Firebase configurado respondem `503`.

### Testes e qualidade

```powershell
python -m pytest              # 315 testes unitários, sem rede, sem Firebase e sem emulador
ruff check .                  # lint
ruff format --check .         # formatação
```

Automático (sobe e encerra emuladores e API, sem credenciais reais), na raiz do repositório:
`npm run test:integration:emulator` — ver [`docs/integracao-api.md` §5](../docs/integracao-api.md).

Manual: testes de integração do Firestore (separados; exigem o emulador ativo — ver
[`docs/firestore.md` §4](../docs/firestore.md#4-firestore-emulator-no-windows)):

```powershell
# outro terminal, na raiz do repositório:
#   firebase emulators:start --only firestore --project demo-mundo-das-patas-test
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8181"
python -m pytest tests_emulator   # 32 testes; sem o emulador, a sessão aborta sem executar nada
```

`requirements.txt` contém só o necessário em execução (FastAPI, Pydantic, Pydantic Settings,
firebase-admin); `requirements-dev.txt` acrescenta Uvicorn, Pytest, HTTPX2 e Ruff.
O `TestClient` do Starlette 1.x usa o `httpx2` (sucessor do HTTPX); o `httpx` clássico continua
instalado como dependência do firebase-admin.

---

## 2. Arquitetura

```
backend/
├── app/
│   ├── main.py                 create_app(): monta a aplicação; `app` para uvicorn/Vercel
│   ├── core/
│   │   ├── config.py           Settings (Pydantic Settings) + validação fail-closed por ambiente
│   │   ├── errors.py           exceções da API, formato único de erro, 500 sem vazamento em logs
│   │   ├── firebase.py         inicialização preguiçosa e única do Firebase Admin SDK
│   │   ├── security.py         verificação de ID Token e autorização administrativa
│   │   └── logging.py          logs JSON de uma linha (sem tracebacks)
│   ├── api/
│   │   ├── dependencies.py     injeção: settings, autenticação, repositórios, serviços
│   │   └── v1/
│   │       ├── router.py       prefixo /api/v1
│   │       ├── public.py       /api/v1/public/*
│   │       └── admin/          /api/v1/admin/* (autenticação aplicada no roteador)
│   ├── domain/                 regras puras (sem HTTP, sem banco)
│   │   ├── models.py           entidades internas (dataclasses imutáveis, snake_case, UTC)
│   │   ├── catalog.py          visibilidade, status de estoque, preço público
│   │   ├── inventory.py        movimentações, vendas, cancelamentos
│   │   └── phone.py            validação de WhatsApp brasileiro
│   ├── schemas/                DTOs HTTP (Pydantic v2), separados por contexto
│   ├── repositories/
│   │   ├── base.py             contratos (Protocols) de persistência
│   │   └── memory.py           implementação em memória (testes/dev)
│   └── services/               casos de uso: orquestram domínio + repositórios
└── tests/                      Pytest (TestClient + dependências substituídas)
```

**Fluxo de uma requisição:** rota (valida o DTO) → serviço (caso de uso) → domínio (regra pura)
→ repositório (Protocol). As rotas não contêm regra de negócio e não conhecem o Firestore.

**Decisões principais**

| Decisão | Motivo |
| --- | --- |
| `create_app(settings, repositories)` | Testes montam a aplicação com configuração própria, sem variáveis globais. |
| Entidades de domínio ≠ DTOs HTTP | O mesmo `Product` gera `ProductAdminOut` (completo) e `PublicProduct` (restrito). Entradas (`ProductCreate`, `ProductUpdate`) não contêm campos controlados pelo servidor. |
| Regras puras em `domain/` | Mesma estratégia de `src/domain/operations.ts`; testáveis sem banco. |
| Protocols específicos (não um repositório genérico) | Cada contrato expõe só as operações reais do sistema. |
| Escritas de estoque só via `InventoryRepository.run_in_transaction` | Venda, estorno, movimentação, cadastro e edição de produto leem e gravam atomicamente. |
| Firebase e Firestore carregados sob demanda | Cold start menor e testes sem credenciais. |
| Sem Redis, filas, workers ou microsserviços | Um único estabelecimento; Firestore + funções serverless bastam. |

---

## 3. Endpoints

Situação: **funcional (memória)** = implementado e testado sobre os repositórios em memória;
passa a usar dados reais quando o repositório Firestore for implementado. Com
`DATA_BACKEND=firestore` (obrigatório em staging/produção), essas rotas respondem
`501 not_implemented` até lá — nunca dados fictícios.

| Método | Caminho | Acesso | Situação |
| --- | --- | --- | --- |
| GET | `/health` | público | funcional |
| GET | `/api/v1/public/catalog` | público | funcional (memória) |
| GET | `/api/v1/public/products/{id}` | público | funcional (memória) |
| GET | `/api/v1/public/categories` | público | funcional (memória) |
| GET | `/api/v1/public/store` | público | funcional (memória) |
| GET | `/api/v1/admin/me` | admin | protegido · funcional (não usa repositórios) |
| GET | `/api/v1/admin/products` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/products` | admin | protegido · funcional (memória) |
| PATCH | `/api/v1/admin/products/{id}` | admin | protegido · funcional (memória) |
| PUT | `/api/v1/admin/products/{id}/image` | admin | protegido · foto do produto (corpo binário JPEG/PNG/WebP ≤ 2 MiB) |
| DELETE | `/api/v1/admin/products/{id}/image` | admin | protegido · remove a foto |
| GET | `/api/v1/admin/images/config` | admin | protegido · envio de fotos disponível? limites |
| GET | `/api/v1/admin/categories` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/categories` | admin | protegido · funcional (memória) |
| PATCH | `/api/v1/admin/categories/{id}` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/stock/movements?limit=&productId=` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/stock/movements` | admin + `Idempotency-Key` | protegido · funcional (memória) |
| GET | `/api/v1/admin/sales?limit=` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/sales` | admin + `Idempotency-Key` | protegido · funcional (memória) |
| POST | `/api/v1/admin/sales/{id}/cancel` | admin + `Idempotency-Key` | protegido · funcional (memória) |
| GET | `/api/v1/admin/dashboard` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/settings` | admin | protegido · funcional (memória) |
| PUT | `/api/v1/admin/settings` | admin | protegido · funcional (memória) |

`GET /api/v1/admin/me` responde só `{"uid": "<uid verificado>"}`. Serve para o frontend confirmar a
autorização antes de abrir o painel: `401` sem token/token inválido, expirado ou revogado; `403` fora
de `ADMIN_ALLOWED_UIDS`; `503` Firebase indisponível ou não configurado. Usa a mesma dependência
`require_admin` do roteador e não depende de persistência (funciona com `DATA_BACKEND=firestore`).

Fotos (TASK 07A): só pelas rotas `/products/{id}/image`; `imageUrl` não é aceito no cadastro/edição.
O servidor valida, recodifica em WebP e grava no Cloud Storage — ver [`docs/storage.md`](../docs/storage.md).

### Regras públicas

- Produto aparece se: publicado, não arquivado, categoria ativa e — se `showOutOfStock=false` — com estoque.
- `priceCents` é `null` quando a loja não exibe o preço (o valor cadastrado não sai do servidor).
- Expostos: `id, name, description, categoryId, brand, imageUrl, priceCents, featured, stock, stockStatus`.
  `stock` é necessário porque a encomenda limita a quantidade ao disponível (como na demo);
  `stockStatus` (`ok`/`low`/`out`) é calculado no servidor para não expor `minStock`.
- Produto oculto responde `404`, como inexistente.
- Nunca expostos: vendas, movimentações, `minStock`, flags de publicação/arquivamento, datas,
  UIDs de administradores, `showOutOfStock`, categorias inativas.

### Formato de erro

```json
{"error": {"code": "insufficient_stock", "message": "Estoque insuficiente: 2 un. disponíveis de “Bola”.", "fieldErrors": {"campo": "mensagem"}}}
```

| Status | `code` | Quando |
| --- | --- | --- |
| 400 | `bad_request` | reservado para requisições inválidas fora da validação de campos (JSON malformado responde 422) |
| 401 | `unauthorized` | sem token, token inválido/expirado/revogado |
| 403 | `forbidden` | usuário autenticado sem permissão administrativa |
| 404 | `not_found` | recurso inexistente ou oculto |
| 405 | `method_not_allowed` | método não suportado |
| 409 | `conflict`, `insufficient_stock`, `idempotency_key_reused`, `idempotency_replay_unavailable` | conflito com o estado atual (ver seção 6) |
| 422 | `validation_error` | campos inválidos (`fieldErrors` no mesmo formato do frontend) |
| 500 | `internal_error` | erro inesperado; cabeçalho `X-Error-Id` correlaciona com o log (ver “Erros inesperados e logs”) |
| 501 | `not_implemented` | persistência real ainda não disponível |
| 503 | `service_unavailable`, `auth_unavailable` | autenticação não configurada, credenciais inválidas ou Firebase indisponível |

---

## 4. Contratos e serialização

- JSON em **camelCase** (`categoryId`, `priceCents`, `createdAt`), compatível com o frontend;
  Python em snake_case, via `alias_generator=to_camel` do Pydantic.
- Datas em **ISO 8601 UTC** (`2026-10-20T12:00:00Z`). Datas sem fuso são recusadas; com outro fuso
  são convertidas para UTC. O frontend usa epoch em ms: o cliente HTTP converte (`Date.parse`).
- Dinheiro em **centavos inteiros** (`priceCents > 0` ou `null`). A conversão "49,90" → 4990
  continua no frontend (`parseBRL`).
- Quantidades: **inteiros estritos** — `"5"`, `5.0` e `true` são recusados.
- Entradas rejeitam campos desconhecidos: não é possível enviar `stock` na edição de produto,
  `createdBy`, timestamps, `archived` no cadastro etc.
- `PATCH` aplica apenas os campos enviados; `null` só é aceito em `priceCents` (remover preço).

### Mapeamento TypeScript → Python

| `src/domain/types.ts` | Domínio Python | Observação |
| --- | --- | --- |
| `Product` | `Product` | `+stockStatus` nas respostas; `imageUrl` só `https://` |
| `Category` | `Category` | id gerado pelo servidor |
| `StockMovement.date` | `StockMovement.created_at` | `+actorUid` (quem fez) |
| `Sale.date` | `Sale.created_at` | `+createdBy`, `+cancelledBy`; itens repetidos são somados |
| `Settings` | `StoreSettings` | WhatsApp validado com a mesma regra de `phone.ts` |
| `Sequences` (`seq`) | — | removido: IDs aleatórios (`uuid4`), seguros com várias instâncias |
| `StoreData` | — | não existe na API: dados públicos e administrativos vêm de rotas separadas |

### Regras reproduzidas de `src/domain`

| Frontend | Backend |
| --- | --- |
| `catalog.ts` `isProductVisible`, `stockStatus` | `domain/catalog.py` |
| `money.ts` `hasPublicPrice` | `domain/catalog.py` |
| `operations.ts` `applyStockMove` | `domain/inventory.py` `plan_stock_move` |
| `operations.ts` `registerSale` | `domain/inventory.py` `plan_sale` |
| `operations.ts` `cancelSale` | `domain/inventory.py` `plan_cancellation` |
| `operations.ts` `saveProduct` / `patchProductFlags` | `services/catalog.py` `ProductService` |
| `operations.ts` `saveCategory` / `toggleCategory` | `services/catalog.py` `CategoryService` |
| `operations.ts` `validateSettings`, `phone.ts` | `services/store.py`, `domain/phone.py` |
| `reports.ts` `catalogSummary` | `services/store.py` `DashboardService` |

---

## 5. Segurança

### Verificação do token

1. O frontend (etapa futura) faz login com o Firebase Authentication e envia
   `Authorization: Bearer <Firebase ID Token>` em cada chamada administrativa.
2. O backend verifica o token com o Firebase Admin SDK (`verify_id_token`, assinatura, expiração,
   projeto) com `check_revoked=True`: usuário desativado ou sessão revogada perde o acesso na hora.
3. A autorização é aplicada no **roteador administrativo inteiro** (`dependencies=[Depends(require_admin)]`),
   então nenhuma rota nova fica desprotegida por esquecimento. Um teste percorre o OpenAPI e
   confirma `401`/`403`/`503` em todas as rotas administrativas.

### Falhas do Firebase: 401 × 503 × 500

`FirebaseTokenVerifier` (`core/security.py`) classifica as exceções reais do firebase-admin 7.x.
Em **todos** os casos o acesso é negado; muda só a resposta, para o frontend saber se deve pedir
novo login (401) ou tentar mais tarde (503).

| Situação | Exceção | Status |
| --- | --- | --- |
| Token inválido, malformado, de outro projeto (`aud`) | `InvalidIdTokenError`, `ValueError` | 401 |
| Token expirado / revogado | `ExpiredIdTokenError` / `RevokedIdTokenError` | 401 |
| Usuário desativado / excluído | `UserDisabledError` / `UserNotFoundError` | 401 |
| Certificados públicos inacessíveis | `CertificateFetchError` | 503 |
| Rede, timeout, erro do serviço | `UnavailableError`, `DeadlineExceededError`, `UnknownError`, `InternalError`, `ResourceExhaustedError` | 503 |
| Credencial administrativa recusada (consulta de revogação) | `UnauthenticatedError`, `PermissionDeniedError` | 503 |
| ADC ausente, credencial malformada, falha ao renovar token | `google.auth.exceptions.GoogleAuthError` (inclui `DefaultCredentialsError`, `RefreshError`) | 503 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` inválido / erro em `initialize_app` | `FirebaseInitFailed` (`core/firebase.py`) | 503 |
| Firebase não configurado | — | 503 |
| Qualquer outra exceção (ex.: `InvalidArgumentError` genérico) | não capturada | 500 |

- `GoogleAuthError` é tratado **antes** de `ValueError`: algumas exceções de credencial do
  `google.auth` (ex.: `MalformedError`) também herdam de `ValueError` e virariam 401 por engano.
- Logs registram só o **tipo** da exceção (nível `INFO` para 401, `ERROR` para 503): mensagens do
  SDK podem conter partes do token ou da credencial.
- Falha na inicialização não deixa o SDK meio inicializado; a próxima requisição tenta de novo.
  A inicialização é única por processo (lock + `get_app`), testada com 8 threads.
- O JSON da conta de serviço precisa ser um **objeto**: `credentials.Certificate()` trataria uma
  string como caminho de arquivo e tentaria abri-lo.

### Estratégia de autorização

**Allowlist de UIDs no servidor** (`ADMIN_ALLOWED_UIDS`). É o modelo mais simples e seguro para
um petshop com um ou poucos usuários:

- Somente quem administra o deploy (variáveis de ambiente) concede acesso.
- Não existe cadastro administrativo público nem rota para conceder permissão.
- Claims enviadas pelo navegador, cabeçalhos como `X-Role` e até claims `admin` no token
  **não** concedem acesso (testado). Allowlist vazia = ninguém é administrador.
- Evolução opcional: custom claims (`admin: true`) definidas por script com o Admin SDK, executado
  por quem tem a conta de serviço. Só vale a pena com mais usuários; a allowlist continua como trava.

### Sem Firebase configurado (fail-closed)

- A aplicação inicia (health check, Swagger, testes, API pública).
- Rotas administrativas: sem token `401`; com token `503`. **Nunca** liberadas.
- Não existe variável de ambiente que desligue a autenticação. Testes trocam a dependência
  `get_token_verifier` explicitamente via `app.dependency_overrides`, o que só é possível em código.
- Em `staging`/`production` a aplicação **não inicia** se: faltar `FIREBASE_PROJECT_ID`, houver
  `DATA_BACKEND=memory`, `FIREBASE_AUTH_EMULATOR_HOST` estiver definido (ele faz o SDK aceitar tokens
  não assinados), `CORS_ORIGINS` contiver `*`, (em produção) origens `http://`, ou
  `FIREBASE_SERVICE_ACCOUNT_JSON` não tiver a estrutura de uma conta de serviço (objeto JSON com
  `type=service_account`, `project_id`, `client_email`, `private_key`). Só a estrutura é conferida,
  sem rede: chave revogada ou ADC ausente aparecem na primeira verificação, como `503`.

### Credenciais e dados sensíveis

- Nenhum arquivo de conta de serviço no repositório (`.gitignore` bloqueia `.env`, `*service-account*.json`,
  `*firebase-adminsdk*.json`).
- `FIREBASE_SERVICE_ACCOUNT_JSON` é `SecretStr`: não aparece em `repr` nem em logs.
- Logs não registram tokens: falhas de verificação registram só o tipo do erro.
- Erros 500 devolvem mensagem genérica e **não registram a mensagem da exceção** (ver abaixo).
- Respostas administrativas com `Cache-Control: no-store`; todas com `X-Content-Type-Options: nosniff`.
- CORS explícito por ambiente, sem cookies (`allow_credentials=False`). CORS não substitui autenticação.

### Erros inesperados e logs

Mensagens de exceção e tracebacks podem conter tokens, senhas, strings de conexão ou dados pessoais.
Por isso uma exceção não tratada **nunca** é registrada com `str(exc)`, `repr(exc)`, `exc.args` ou
traceback. O log (`app.errors`, nível `ERROR`) traz apenas metadados controlados:

```json
{"ts": "…", "level": "ERROR", "logger": "app.errors",
 "message": "Erro inesperado: id=3f9c… tipo=RuntimeError causas=KeyError origem=app.services.inventory:register_sale:120 metodo=POST rota=/api/v1/admin/sales"}
```

| Campo | Conteúdo |
|---|---|
| `id` | identificador da ocorrência; o mesmo valor vai na resposta, no cabeçalho `X-Error-Id` |
| `tipo` / `causas` | classes da exceção e da cadeia `__cause__`/`__context__` (só os nomes) |
| `origem` | módulo, função e linha onde a exceção foi lançada (sem valores) |
| `metodo` / `rota` | método HTTP e **modelo** da rota (`/products/{product_id}`); nunca o caminho real, a query string, cabeçalhos, cookies ou corpo |

Como o tratamento funciona (`core/errors.py`):

- O `ServerErrorMiddleware` do Starlette responde 500 e **relança** a exceção ao servidor ASGI; o
  Uvicorn então imprime `Exception in ASGI application` com o traceback completo. Suprimir apenas o
  log da aplicação não resolveria.
- `UnexpectedErrorGuard` (middleware ASGI) fica em duas posições: logo acima das rotas, onde responde
  500 sem relançar (a resposta ainda recebe CORS e `X-Content-Type-Options`/`Cache-Control`), e por
  fora de toda a pilha, onde contém falhas dos próprios middlewares e descarta a exceção relançada
  pelo `ServerErrorMiddleware`. Nenhuma exceção chega ao servidor; cada ocorrência gera um único log.
- O `JsonFormatter` não grava tracebacks: um `logger.exception(...)` futuro registra só `exceptionType`.
- Erros conhecidos (400, 401, 403, 404, 409, 422, 501, 503) continuam com seus handlers e não geram
  esse log.
- Os testes (`tests/test_error_logging.py`) usam marcadores fictícios em mensagens, causas
  encadeadas, cabeçalhos, caminho, query e corpo, inclusive com um Uvicorn real em subprocesso.

Limitações fora do controle da aplicação:

- **Log de acesso do Uvicorn** registra a linha da requisição com caminho e **query string**
  (`"GET /rota?x=… HTTP/1.1" 500`). A API não recebe segredos na URL (o token vai no cabeçalho
  `Authorization`), mas em ambientes compartilhados prefira `uvicorn … --no-access-log`.
- **Plataforma de hospedagem** (Vercel) mantém seus próprios logs de requisição (URL, status, duração);
  revise a retenção e o acesso a eles na homologação.
- Exceções lançadas **depois** de a resposta começar (streaming) não podem virar 500: o log seguro é
  emitido e a conexão é encerrada. A API atual não usa streaming.

---

## 6. Persistência, transações e idempotência

### Contratos (`repositories/base.py`)

| Protocol | Operações |
| --- | --- |
| `CategoryRepository` | `list`, `get`, `save` (garante nome único de forma atômica; `CategoryNameTaken`) |
| `ProductRepository` | `list`, `get` (somente leitura) |
| `SaleRepository` | `list(limit, since)`, `get` |
| `StockMovementRepository` | `list(limit, product_id)`, `get` (imutáveis) |
| `SettingsRepository` | `get`, `save` |
| `InventoryRepository` | `run_in_transaction(fn)` com leituras e escritas de produtos, vendas, movimentações e chaves de idempotência |

### Firestore (`repositories/firestore.py`)

Coleções, serialização, índices, emulador, configuração real e limites do plano Spark:
[`docs/firestore.md`](../docs/firestore.md). Resumo:

| Coleção | Documento | Observação |
| --- | --- | --- |
| `products`, `categories`, `sales`, `stock_movements` | `{id}` | snake_case, Timestamps UTC, centavos inteiros |
| `category_name_claims` | `sha256(normalize_text(nome))` | reserva do nome (unicidade) |
| `settings` | `store` | inexistente = padrões calculados, nunca gravados implicitamente |
| `idempotency_keys` | `sha256([operation, actor_uid, key])` | snapshot da resposta; expiração lógica (sem TTL no Spark) |

- `FIRESTORE_DATABASE_ID` permite usar um banco nomeado (ex.: separar homologação de produção).
- Dados de demonstração **não** são inseridos. Uma importação inicial, se desejada, será um
  script explícito e separado.

### Transações

`run_in_transaction` usa `@firestore.transactional`, com repetição adicional em disputa (ver `docs/firestore.md`):

- **Venda:** lê todos os produtos da venda e a chave de idempotência → valida tudo → grava a venda,
  o novo estoque de cada produto, as movimentações e a chave. Tudo ou nada.
- **Duas vendas simultâneas do último item:** o Firestore detecta que o documento do produto mudou e
  repete a transação; na repetição o estoque lido é 0 e a segunda venda recebe `409 insufficient_stock`.
  (Coberto por testes concorrentes em memória e no Firestore Emulator, cada thread com seu cliente.)
- **Cancelamento:** lê a chave de idempotência, a venda e os produtos → se a chave já existe, devolve
  o snapshot; se a venda já está `cancelada`, responde `409`; senão grava venda, estoque, estornos e
  chave. Dois cancelamentos simultâneos não estornam duas vezes (testado com 8 threads).
- **Edição de produto:** relê o produto dentro da transação, para não sobrescrever um estoque alterado em paralelo.
- A função da transação não pode ter efeitos colaterais externos (o Firestore pode repeti-la).

### Idempotência

`POST /admin/sales`, `POST /admin/stock/movements` e `POST /admin/sales/{id}/cancel` exigem o
cabeçalho `Idempotency-Key` (8–128 caracteres `A-Z a-z 0-9 _ . : -`, ex.: `crypto.randomUUID()`).
O escopo da chave é **(operação, usuário)**: a mesma chave usada por outro administrador ou em
outra operação é independente.

| Requisição | Resposta |
| --- | --- |
| Chave nova | Executa. `201` (venda, movimentação) ou `200` (cancelamento), `Idempotent-Replayed: false` |
| Mesma chave, mesmo corpo (no cancelamento: mesma venda) | **Snapshot da resposta original**, mesmo status, `Idempotent-Replayed: true`; nada é reaplicado |
| Mesma chave, outro corpo / outra venda | `409 idempotency_key_reused`; nada é aplicado |
| Operação recusada (ex.: estoque insuficiente) | Erro normal; a chave **não** é registrada e pode ser reutilizada |
| Cancelamento com chave nova de venda já cancelada | `409 conflict`; estoque inalterado |

```http
POST /api/v1/admin/sales/3f2a.../cancel
Authorization: Bearer <Firebase ID Token>
Idempotency-Key: 0b8e6c1e-5d1f-4c3a-9a57-2f0d7f1b9c44

→ 200  Idempotent-Replayed: false   {"id": "3f2a...", "status": "cancelada", ...}
(resposta perdida; o navegador repete com a MESMA chave)
→ 200  Idempotent-Replayed: true    {mesmo JSON da primeira resposta}
```

O frontend deve gerar a chave ao **abrir** a confirmação da operação e reutilizá-la em todas as
novas tentativas daquela ação; uma nova ação usa uma nova chave.

**Snapshot.** O registro (`IdempotencyRecord`) guarda operação, usuário, chave, hash do corpo,
ID do recurso, `created_at`, `expires_at` e a **resposta original** serializada (`response`, texto
JSON). A repetição desserializa esse texto — nunca consulta o estado atual. Ex.: entrada K1 (10 → 12),
depois entrada K2 (→ 15): repetir K1 devolve `stock: 12`. Venda K1 depois cancelada: repetir K1
devolve a venda `concluida`, sem criar outra venda nem nova baixa.

- O registro é gravado na mesma transação da operação: ou ambos existem, ou nenhum.
- **Acoplamento assumido:** o snapshot é o DTO HTTP (`SaleOut`, `StockMovementResult`), gerado
  pelo serviço; o domínio só o trata como texto opaco. O formato tem versão (`response_version`,
  constante `SNAPSHOT_VERSION` em `services/inventory.py`). Ao mudar um desses DTOs de forma
  incompatível, incremente a versão: registros antigos passam a responder
  `409 idempotency_replay_unavailable` (a operação já foi aplicada; o cliente deve consultar o recurso)
  — **nunca** são reaplicados.

**Expiração (`IDEMPOTENCY_TTL` = 24 horas).** `expires_at = created_at + 24 h`, com o relógio do servidor
no momento da operação.

- Antes de `expires_at`: repetições devolvem o snapshot; corpo diferente recebe `409`.
- A partir de `expires_at`: o registro é **ignorado** mesmo que ainda exista (o TTL do Firestore
  apaga com atraso de até ~24 h, e o comportamento não pode depender disso). A chave volta a ser
  nova: uma repetição de venda ou de movimentação **seria executada outra vez**. O cancelamento
  continua seguro (a venda já está `cancelada` → `409`), mas sem o snapshot.
- Portanto a proteção contra repetição vale **por 24 horas**, não indefinidamente. Retries
  automáticos e duplos cliques acontecem em segundos; 24 h cobrem também uma aba reaberta no dia seguinte.
- Não há limpeza agendada: em memória os registros vivem até o processo reiniciar; no Firestore os
  documentos expirados permanecem (inertes) — o TTL exige faturamento e não foi habilitado no plano
  Spark. Crescimento e manutenção futura: `docs/firestore.md` §6.

### Unicidade de categorias

Dois nomes são equivalentes quando `normalize_text` (sem acentos, sem diferença de caixa) é igual:
`Ração`, `racao` e `RAÇÃO` são o mesmo nome. A unicidade é garantida no `save` do repositório, de
forma atômica — não por consulta seguida de inserção no serviço:

- Criação ou renomeação para nome usado por outra categoria → `409` com
  `fieldErrors.name`; nada da requisição é aplicado (nem outros campos do mesmo `PATCH`).
- Manter o próprio nome (inclusive mudando só maiúsculas/acentos) é permitido.
- Depois de uma renomeação, o nome antigo fica livre para outra categoria.
- **Memória:** verificação e gravação na mesma seção crítica (o lock já usado pelos repositórios).
- **Firestore:** índices não impõem unicidade. `save` é uma transação que lê a categoria atual e
  `category_name_claims/{sha256(nome normalizado)}`; se a reserva pertence a outro ID → conflito;
  senão grava a categoria, cria a reserva nova e, numa renomeação, apaga a reserva antiga — tudo
  na mesma transação. Duas transações concorrentes sobre a mesma reserva: o Firestore repete uma
  delas, que então encontra a reserva ocupada. O hash evita caracteres inválidos em IDs de documento.

### Validação no Firestore Emulator

Os testes em memória validam a lógica; `tests_emulator/` valida o comportamento real do Firestore:
persistência após recriar os repositórios, serialização de Timestamps, consultas e ordenação,
rollback sem escrita parcial, venda multi-item, estoque insuficiente, estorno único, replays após
alterações posteriores, expiração, perda da resposta após o commit, e concorrência (último item,
mesma chave, venda × ajuste, cancelamentos, edição × estoque, nomes de categoria). Invariante
verificado: `estoque = inicial + Σ movimentações`, nunca negativo.

- Ordem leituras → escritas: imposta pela transação (`ReadAfterWrite`).
- Reexecução: `now`, IDs e a semente dos IDs das movimentações são fixados antes da transação
  (`derived_ids`); o snapshot é derivado do que foi lido; nenhum efeito externo.
- `put_idempotency` usa `set` no ID determinístico (sobrescreve um registro expirado); movimentações
  usam `create` (imutáveis).
- Limite de 1 MiB por documento: o maior snapshot (venda com 100 itens) fica muito abaixo.
- A edição de categoria lê a categoria atual fora da transação (comportamento anterior, last-write-wins
  para `active`/`icon`); a unicidade do nome, porém, é decidida dentro da transação.

### WhatsApp

A encomenda pelo WhatsApp **não altera estoque e não cria venda**. O estoque só muda quando um
administrador registra a venda concluída no painel. Não há reserva de estoque nem WhatsApp Business API.

---

## 7. Configuração (variáveis de ambiente)

Lidas do ambiente e, em desenvolvimento, de `backend/.env` (modelo em `.env.example`).

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `APP_ENV` | `local` | `local`, `test`, `staging`, `production` |
| `LOG_LEVEL` | `INFO` | nível dos logs JSON |
| `CORS_ORIGINS` | vazio | origens autorizadas, separadas por vírgula |
| `DATA_BACKEND` | `memory` | `memory` (só local/test) ou `firestore` |
| `FIREBASE_PROJECT_ID` | vazio | obrigatório em staging/produção; vazio = admin indisponível (503) |
| `FIRESTORE_DATABASE_ID` | `(default)` | banco Firestore |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | vazio | conteúdo JSON da conta de serviço (segredo); sem ele, Application Default Credentials |
| `FIREBASE_AUTH_EMULATOR_HOST` | vazio | apenas emulador local; proibido em staging/produção |
| `FIRESTORE_EMULATOR_HOST` | vazio | `host:porta` do Firestore Emulator, **no ambiente do processo** (não basta o `.env`); proibido em staging/produção |
| `ADMIN_ALLOWED_UIDS` | vazio | UIDs autorizados no painel |

---

## 8. Configurar o Firebase (próximas etapas)

1. Criar o projeto no console do Firebase (manual, pelo proprietário da conta).
2. Ativar **Authentication → E-mail/senha**; desativar o cadastro público de usuários
   (criar as contas administrativas manualmente no console).
3. Copiar o UID de cada administrador para `ADMIN_ALLOWED_UIDS`.
4. Criar uma conta de serviço com o papel mínimo necessário; guardar o JSON **fora do repositório**:
   - local: `$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora\do\repo\chave.json"`;
   - hospedagem: conteúdo em `FIREBASE_SERVICE_ACCOUNT_JSON` como variável secreta.
5. Definir `FIREBASE_PROJECT_ID`. A verificação de tokens passa a funcionar sem mudança de código.
6. Firestore: banco `(default)` já criado. Regras deny-all (`firestore.rules`) e índices
   (`firestore.indexes.json`) estão prontos, **não publicados** — publicação manual e verificação de
   conectividade em [`docs/firestore.md` §5](../docs/firestore.md#5-firestore-real-mundo-das-patas---dev).

---

## 9. Hospedagem futura na Vercel

A aplicação já segue as restrições de ambiente serverless:

- Sem estado em memória entre requisições na configuração de produção (memória é proibida fora de local/test).
- Sem arquivos locais persistentes; sem sequências locais (IDs aleatórios).
- Firebase inicializado uma vez por instância, sob demanda (`get_firebase_app` com lock).
- Sem tarefas longas na requisição; sem conexões abertas na importação.
- Todas as configurações por variáveis de ambiente.

Para o deploy (task própria, não executada aqui): projeto Vercel com **Root Directory = `backend`**,
runtime Python lendo `requirements.txt`, e entrypoint apontando para a instância `app` de
`app/main.py` — confirmar na documentação vigente da Vercel se é necessário um arquivo de
entrada (ex.: `index.py` reexportando `app`) ou `vercel.json`. Atenção ao tamanho do pacote:
o firebase-admin traz `google-cloud-firestore` e `grpcio`.

---

## 10. Auditoria do frontend e plano de integração React → API

### O que foi reaproveitado

- Tipos de `src/domain/types.ts` → entidades e DTOs (mesmos nomes de campos em JSON).
- Regras de `operations.ts`, `catalog.ts`, `money.ts`, `phone.ts`, `reports.ts` → reproduzidas e
  testadas com os mesmos cenários.
- O contrato `StoreApi` e o ponto único `src/app/services.ts` permitem trocar a implementação
  sem reescrever componentes.

### Diferenças entre a demo e a arquitetura real

| Demo | Real |
| --- | --- |
| `StoreData` inteiro no navegador (inclui vendas e movimentações) | Público recebe só `PublicCatalog`; o restante exige login |
| Estoque calculado no navegador | Backend é a autoridade; operações em transação |
| IDs por sequência (`p20`, `V-0001`) | IDs aleatórios gerados pelo servidor |
| Datas em ms | ISO 8601 UTC |
| Imagem como data URL no localStorage | URL https (Cloud Storage) |
| `resetDemo`, `persisted`, `storageFull` | Não existem na API real |
| Painel aberto | Firebase Authentication + allowlist |

### Alterações necessárias no frontend (fase de integração — não feitas nesta task)

1. Criar `src/services/httpStoreApi.ts` implementando `StoreApi` com `fetch`, convertendo datas
   ISO ↔ ms, mapeando `{error: {message, fieldErrors}}` para `ApiResult` e enviando
   `Idempotency-Key` (gerada por ação) em vendas, movimentações e cancelamentos.
2. Separar o carregamento público do administrativo: a vitrine usa `GET /public/catalog`;
   o painel compõe `GET /admin/products|categories|sales|stock/movements|settings` após o login.
   Hoje `StoreProvider` carrega um único `StoreData` para as duas áreas.
3. Tipo de produto público (sem `minStock`, com `stockStatus`): `ProductCard`/`ProductDetailModal`
   usam `stockStatus(p)` com `minStock`; passarão a ler o campo do servidor.
4. `ProductFormInput` envia textos (`price`, `stock`, `minStock`): o cliente HTTP converte com
   `parseBRL`/`parseInt` antes de enviar. `saveProduct` com `id` vira `PATCH`, sem `stock`.
5. `toggleCategory` → `PATCH /admin/categories/{id}` com `{active}`; `patchProduct` → `PATCH` com as flags.
6. ~~Login administrativo com Firebase JS SDK~~ — feito na TASK 05B (`src/features/auth`,
   `src/services/auth/adminHttp.ts`, que já obtém/renova o token pelo SDK e trata 401).
7. Exibir um código curto de venda (ex.: últimos caracteres do id) no lugar de `V-0001`, ou
   criar um número sequencial em transação, se o cliente fizer questão.
8. Escolher a implementação em `src/app/services.ts` por variável de build (`VITE_API_URL`),
   mantendo `localStoreApi` para o GitHub Pages.

---

## 11. Pendências

- **Firebase:** credenciais do servidor (ADC ou conta de serviço) e `backend/.env` locais — ver
  [`docs/autenticacao.md`](../docs/autenticacao.md).
- **Autenticação real:** login implementado (TASK 05B); falta o smoke test ponta a ponta com o usuário real.
- **Firestore real:** publicar regras/índices e executar o smoke test (com aprovação do proprietário);
  TTL de `idempotency_keys` quando houver faturamento — ver [`docs/firestore.md`](../docs/firestore.md).
- **Imagens:** envio implementado e validado no Storage Emulator (TASK 07A); o bucket real exige o
  plano Blaze — ver [`docs/storage.md`](../docs/storage.md) §7.
- **Integração React:** itens da seção 10.
- **Homologação:** deploy na Vercel (staging), domínio, CORS de homologação, monitoramento de logs
  (incluindo os logs de requisição da plataforma, que a aplicação não controla).
- Paginação por cursor em vendas/movimentações quando o volume crescer (hoje `limit` até 500).
