# Mundo das Patas — Backend (FastAPI)

Fundação da API real do Mundo das Patas (TASK 04). O frontend React na raiz do repositório
**continua usando os dados demonstrativos** (`localStoreApi`) e o GitHub Pages não foi alterado.

> **Situação:** arquitetura, contratos, segurança e regras de negócio prontos e testados.
> **Ainda não há banco real** (Firestore) nem login real (Firebase Authentication configurado).
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

- API: <http://localhost:8000>
- Health check: <http://localhost:8000/health>
- Swagger (OpenAPI): <http://localhost:8000/docs> (desativado quando `APP_ENV=production`)

Não é preciso nenhuma credencial do Firebase para iniciar a aplicação, ver o health check e
consultar a API pública. As rotas administrativas continuam protegidas: sem token respondem
`401`, e com token mas sem Firebase configurado respondem `503`.

### Testes e qualidade

```powershell
python -m pytest              # 186 testes, sem rede e sem Firebase real
ruff check .                  # lint
ruff format --check .         # formatação
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
│   │   ├── errors.py           exceções da API e formato único de erro
│   │   ├── firebase.py         inicialização preguiçosa e única do Firebase Admin SDK
│   │   ├── security.py         verificação de ID Token e autorização administrativa
│   │   └── logging.py          logs JSON de uma linha
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
| GET | `/api/v1/admin/products` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/products` | admin | protegido · funcional (memória) |
| PATCH | `/api/v1/admin/products/{id}` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/categories` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/categories` | admin | protegido · funcional (memória) |
| PATCH | `/api/v1/admin/categories/{id}` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/stock/movements?limit=&productId=` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/stock/movements` | admin + `Idempotency-Key` | protegido · funcional (memória) |
| GET | `/api/v1/admin/sales?limit=` | admin | protegido · funcional (memória) |
| POST | `/api/v1/admin/sales` | admin + `Idempotency-Key` | protegido · funcional (memória) |
| POST | `/api/v1/admin/sales/{id}/cancel` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/dashboard` | admin | protegido · funcional (memória) |
| GET | `/api/v1/admin/settings` | admin | protegido · funcional (memória) |
| PUT | `/api/v1/admin/settings` | admin | protegido · funcional (memória) |

Upload de imagens: **contrato futuro, sem rota.** O produto guarda apenas `imageUrl` (`https://`
ou vazio); data URLs, usadas na demo, são recusadas. O upload irá para o Cloud Storage.

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
| 409 | `conflict`, `insufficient_stock`, `idempotency_key_reused` | conflito com o estado atual |
| 422 | `validation_error` | campos inválidos (`fieldErrors` no mesmo formato do frontend) |
| 500 | `internal_error` | erro inesperado (detalhes só no log do servidor) |
| 501 | `not_implemented` | persistência real ainda não disponível |
| 503 | `service_unavailable` | autenticação não configurada ou indisponível |

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
  não assinados), `CORS_ORIGINS` contiver `*` ou (em produção) origens `http://`.

### Credenciais e dados sensíveis

- Nenhum arquivo de conta de serviço no repositório (`.gitignore` bloqueia `.env`, `*service-account*.json`,
  `*firebase-adminsdk*.json`).
- `FIREBASE_SERVICE_ACCOUNT_JSON` é `SecretStr`: não aparece em `repr` nem em logs.
- Logs não registram tokens: falhas de verificação registram só o tipo do erro.
- Erros 500 devolvem mensagem genérica; o detalhe fica apenas no log.
- Respostas administrativas com `Cache-Control: no-store`; todas com `X-Content-Type-Options: nosniff`.
- CORS explícito por ambiente, sem cookies (`allow_credentials=False`). CORS não substitui autenticação.

---

## 6. Persistência, transações e idempotência

### Contratos (`repositories/base.py`)

| Protocol | Operações |
| --- | --- |
| `CategoryRepository` | `list`, `get`, `save` |
| `ProductRepository` | `list`, `get` (somente leitura) |
| `SaleRepository` | `list(limit, since)`, `get` |
| `StockMovementRepository` | `list(limit, product_id)`, `get` (imutáveis) |
| `SettingsRepository` | `get`, `save` |
| `InventoryRepository` | `run_in_transaction(fn)` com leituras e escritas de produtos, vendas, movimentações e chaves de idempotência |

### Firestore (próxima etapa)

| Coleção | Documento | Observação |
| --- | --- | --- |
| `products` | `{id}` | campos snake_case ou camelCase (decidir na implementação), timestamps nativos |
| `categories` | `{id}` | |
| `sales` | `{id}` | índice em `created_at` |
| `stock_movements` | `{id}` | índices em `created_at` e (`product_id`, `created_at`) |
| `settings` | `store` | documento único |
| `idempotency_keys` | hash(`operation`, `actor_uid`, `key`) | política de TTL do Firestore (ex.: `expires_at` = criação + 7 dias) |

- `FIRESTORE_DATABASE_ID` permite usar um banco nomeado (ex.: separar homologação de produção).
- Dados de demonstração **não** devem ser inseridos em produção. Uma importação inicial, se
  desejada, será um script explícito e separado.

### Transações

`run_in_transaction` mapeia para `@firestore.transactional`:

- **Venda:** lê todos os produtos da venda e a chave de idempotência → valida tudo → grava a venda,
  o novo estoque de cada produto, as movimentações e a chave. Tudo ou nada.
- **Duas vendas simultâneas do último item:** o Firestore detecta que o documento do produto mudou e
  repete a transação; na repetição o estoque lido é 0 e a segunda venda recebe `409 insufficient_stock`.
  (Coberto por teste concorrente com 8 threads sobre o repositório em memória.)
- **Cancelamento:** lê a venda dentro da transação; se já está `cancelada`, responde `409`. Dois
  cancelamentos simultâneos não estornam duas vezes.
- **Edição de produto:** relê o produto dentro da transação, para não sobrescrever um estoque alterado em paralelo.
- A função da transação não pode ter efeitos colaterais externos (o Firestore pode repeti-la).

### Idempotência

`POST /admin/sales` e `POST /admin/stock/movements` exigem o cabeçalho `Idempotency-Key`
(8–128 caracteres, ex.: `crypto.randomUUID()`):

- Mesma chave + mesmo usuário + mesmo corpo → devolve o resultado original com
  `Idempotent-Replayed: true`, sem reaplicar (duplo clique, retry após falha de rede).
- Mesma chave com outro corpo → `409 idempotency_key_reused`.
- A chave é gravada na mesma transação da operação: ou ambas existem, ou nenhuma.
- O frontend deve gerar a chave ao **abrir** a confirmação da operação e reutilizá-la em novas tentativas.
- Cancelamento é naturalmente idempotente (verificação de status na transação).

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
6. Firestore (etapa seguinte): criar o banco, regras de segurança negando acesso direto do
   navegador (todo acesso passa pela API), índices e política de TTL de `idempotency_keys`.

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
   `Idempotency-Key` (gerada por ação) em vendas e movimentações.
2. Separar o carregamento público do administrativo: a vitrine usa `GET /public/catalog`;
   o painel compõe `GET /admin/products|categories|sales|stock/movements|settings` após o login.
   Hoje `StoreProvider` carrega um único `StoreData` para as duas áreas.
3. Tipo de produto público (sem `minStock`, com `stockStatus`): `ProductCard`/`ProductDetailModal`
   usam `stockStatus(p)` com `minStock`; passarão a ler o campo do servidor.
4. `ProductFormInput` envia textos (`price`, `stock`, `minStock`): o cliente HTTP converte com
   `parseBRL`/`parseInt` antes de enviar. `saveProduct` com `id` vira `PATCH`, sem `stock`.
5. `toggleCategory` → `PATCH /admin/categories/{id}` com `{active}`; `patchProduct` → `PATCH` com as flags.
6. Login administrativo com Firebase JS SDK, `getIdToken()` em cada chamada, tratamento de 401/403.
7. Exibir um código curto de venda (ex.: últimos caracteres do id) no lugar de `V-0001`, ou
   criar um número sequencial em transação, se o cliente fizer questão.
8. Escolher a implementação em `src/app/services.ts` por variável de build (`VITE_API_URL`),
   mantendo `localStoreApi` para o GitHub Pages.

---

## 11. Pendências

- **Firebase:** criar projeto, contas administrativas, conta de serviço, variáveis de ambiente.
- **Autenticação real:** login no frontend e teste ponta a ponta com token real (ou Emulator Suite).
- **Firestore:** implementar `repositories/firestore.py` seguindo os Protocols, regras de segurança,
  índices, TTL de idempotência; testes de integração com o emulador.
- **Imagens:** upload para o Cloud Storage com URLs assinadas ou regras de Storage.
- **Integração React:** itens da seção 10.
- **Homologação:** deploy na Vercel (staging), domínio, CORS de homologação, monitoramento de logs.
- Paginação por cursor em vendas/movimentações quando o volume crescer (hoje `limit` até 500).
