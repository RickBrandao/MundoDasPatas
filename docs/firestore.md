# Cloud Firestore — persistência do backend (TASK 06B)

O backend FastAPI é o **único** cliente do Firestore. O navegador nunca acessa o banco: regras
deny-all (`firestore.rules`) e todo acesso via API, com Firebase Authentication + `ADMIN_ALLOWED_UIDS`.
O frontend continua demonstrativo (`localStoreApi`) até a integração (TASK 06C).

Sumário: [Alternar memória × Firestore](#1-alternar-memória--firestore) ·
[Modelagem](#2-modelagem) · [Índices](#3-índices) · [Emulador no Windows](#4-firestore-emulator-no-windows) ·
[Firestore real](#5-firestore-real-mundo-das-patas---dev) · [Plano Spark](#6-plano-spark-e-limitações) ·
[Pendências](#7-pendências)

---

## 1. Alternar memória × Firestore

| `DATA_BACKEND` | Repositórios | Uso |
| --- | --- | --- |
| `memory` (padrão local/test) | `repositories/memory.py` | testes unitários e desenvolvimento isolado; dados somem ao reiniciar; **proibido** em staging/produção |
| `firestore` | `repositories/firestore.py` | emulador local ou banco real; obrigatório em staging/produção |

Com `firestore`, nenhuma conexão é aberta na inicialização: o cliente nasce na primeira operação
de dados. Configuração incompleta ou banco indisponível **não** caem para memória — as rotas de
dados respondem `503`:

| Situação | Resposta | Log (sem valores sensíveis) |
| --- | --- | --- |
| Sem `FIREBASE_PROJECT_ID`, credenciais ausentes/inválidas, `FIRESTORE_EMULATOR_HOST` só no `.env` | `503 database_unavailable` | motivo, sem segredos |
| Rede, timeout, permissão negada, índice ausente | `503 database_unavailable` | tipo da exceção e código gRPC |
| Disputa persistente entre transações | `503 database_busy` | número de rodadas |
| Regra de negócio (estoque insuficiente, nome duplicado…) | `409`/`422`, inalterado | — |

`GET /health` informa `database.status` = `ephemeral` (memória), `emulator`, `configured` ou
`not_configured`, sem expor o ID do projeto e **sem** testar a conexão (para isso, ver §5).

---

## 2. Modelagem

Documentos em **snake_case** (camelCase só no JSON da API); o ID fica só no ID do documento;
datas como Timestamp nativo (UTC; datas sem fuso são recusadas); dinheiro em centavos e
quantidades como inteiros; enums pelo valor. Conversões explícitas em `repositories/firestore_codec.py`.

| Coleção / documento | Campos | Observação |
| --- | --- | --- |
| `categories/{id}` | `name, icon, active` | |
| `category_name_claims/{sha256(nome normalizado)}` | `category_id, normalized_name` | reserva do nome (unicidade) |
| `products/{id}` | `name, description, category_id, brand, image_url, price_cents, show_price, stock, min_stock, published, featured, archived, created_at, updated_at` | estoque só muda em transação |
| `sales/{id}` | `items[{product_id, qty}], status, created_at, created_by, cancelled_at, cancelled_by` | |
| `stock_movements/{id}` | `product_id, type, qty, created_at, note, origin, actor_uid` | imutáveis (`create`) |
| `settings/store` | `store_name, whatsapp, address, hours, about, show_out_of_stock, show_featured` | inexistente = padrões calculados (não gravados) |
| `idempotency_keys/{sha256([operação, uid, chave])}` | `key, operation, actor_uid, request_hash, result_id, response, response_version, created_at, expires_at` | snapshot da resposta original |

Nenhum dado de cliente final nem documento financeiro é criado. Nada é importado automaticamente:
o banco vazio responde um catálogo vazio.

### Transações

`InventoryRepository.run_in_transaction` usa transações do Firestore. Exemplo, a venda: lê chave
de idempotência e produtos → valida estoque → grava venda, produtos, movimentações e chave — tudo
ou nada. Cancelamento e movimentação seguem o mesmo padrão; a edição de produto relê o produto
na transação (não sobrescreve estoque alterado em paralelo).

- Leituras sempre antes das escritas (uma leitura após escrita é erro de programação: `ReadAfterWrite`).
- Reexecução segura: horário, ID da venda e semente dos IDs das movimentações são fixados **fora**
  da função; dentro dela os IDs das movimentações derivam da semente (`derived_ids`) e se repetem
  idênticos a cada reexecução. Nenhum efeito externo (WhatsApp, HTTP) dentro da transação.
- O SDK repete commits recusados (5×, sem espera); além disso, o repositório repete a função
  inteira em até 5 rodadas com espera aleatória crescente (também para `Aborted` em leituras, que
  o SDK não repete). Esgotado: `503 database_busy` — repetir com a **mesma** `Idempotency-Key` é seguro.
- Nenhum lock Python garante consistência: várias instâncias podem operar ao mesmo tempo.

### Idempotência

Comportamento da TASK 04.3 preservado: escopo (operação, usuário, chave), hash do corpo, snapshot
versionado, `expires_at = created_at + 24 h`. O documento tem ID determinístico; `set` substitui
um registro expirado. A expiração é **lógica** (comparada no código): independe de o documento
ter sido apagado.

### Unicidade de categorias

`CategoryRepository.save` numa transação: lê a categoria atual e a reserva do novo nome (e, numa
renomeação, a reserva antiga) → reserva de outro ID = `409` → grava categoria, cria a nova reserva
e apaga a antiga. `"Ração"`, `"racao"` e `"RAÇÃO"` disputam o mesmo documento de reserva.

---

## 3. Índices

`firestore.indexes.json` (raiz do repositório):

| Consulta | Índice |
| --- | --- |
| Vendas por `created_at` desc, com `created_at >=` (dashboard) | simples, automático |
| Movimentações por `created_at` desc | simples, automático |
| Movimentações de um produto (`product_id ==`, `created_at` desc) | **composto** `stock_movements (product_id ASC, created_at DESC)` |
| `idempotency_keys.response` | **isenção** de índice (texto grande nunca consultado) |

Produtos e categorias são lidos por inteiro (catálogo de uma loja: dezenas/centenas de documentos).
O dashboard faz **uma** consulta de vendas (30 dias, até 10.000) e deriva os 7 dias em memória.
O emulador **não** exige índices compostos: a ausência do índice só aparece no banco real
(`503 database_unavailable`, log `FailedPrecondition`).

---

## 4. Firestore Emulator no Windows

Pré-requisitos já verificados nesta máquina: Java 21 (`java -version`) e Firebase CLI 15.16.0
(`firebase --version`). Se faltarem: Java 11+ (ex.: Temurin) e `npm install -g firebase-tools`.

`firebase.json` (raiz) fixa o emulador em `127.0.0.1:8181` (a 8080 padrão costuma estar ocupada
por outros serviços; se a 8181 também estiver, mude a porta no `firebase.json` e na variável).
Não há `.firebaserc`: nenhum comando usa o projeto real por padrão.

```powershell
# Terminal 1 — na raiz do repositório. Projeto "demo-*": só existe no emulador.
netstat -ano | findstr ":8181"        # porta livre? (não encerre processos de outros projetos)
firebase emulators:start --only firestore --project demo-mundo-das-patas-test

# Terminal 2 — backend
cd backend
.\.venv\Scripts\Activate.ps1
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8181"   # host:porta, SEM http://
python -m pytest tests_emulator                   # testes de integração (separados da suíte comum)
Remove-Item Env:FIRESTORE_EMULATOR_HOST           # ao terminar
```

Travas dos testes do emulador (`tests_emulator/conftest.py`), checadas antes de qualquer escrita:
variável definida, sem protocolo e em loopback; o endereço responde como o emulador; projeto
`demo-*` diferente do real; cliente efetivamente em modo emulador (credenciais anônimas). A limpeza
usa a API REST exclusiva do emulador. Falhando qualquer trava, a sessão termina sem executar nada.

API local contra o emulador:

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8181"
$env:DATA_BACKEND = "firestore"
$env:FIREBASE_PROJECT_ID = "demo-mundo-das-patas"    # sobrepõe o .env
uvicorn app.main:app --reload --port 8000
```

> O SDK lê `FIRESTORE_EMULATOR_HOST` do **ambiente do processo**, não do `.env`. Se a variável
> estiver só no `.env`, a API recusa (503) em vez de se conectar ao projeto real por engano.
> Em staging/produção a variável é proibida (a aplicação não inicia).

**Limitação observada no emulador:** ele resolve impasses de lock por timeout (~10 s por rodada).
Muitas transações simultâneas sobre o mesmo documento ficam lentas e podem chegar a `database_busy`
(nunca a dados inconsistentes). O Firestore real usa *wound-wait* e não tem esse atraso. Os testes
concorrentes usam 4 threads por isso.

---

## 5. Firestore real (`mundo-das-patas---dev`)

**Nada foi gravado no banco real nesta task**, e regras, índices e IAM remotos não foram alterados.

### Configuração (manual, pelo proprietário)

1. Credenciais do servidor — as mesmas da autenticação (`docs/autenticacao.md`): ADC
   (`gcloud auth application-default login` ou `GOOGLE_APPLICATION_CREDENTIALS` para um JSON
   **fora** do repositório) ou `FIREBASE_SERVICE_ACCOUNT_JSON` na hospedagem.
2. Permissão mínima da conta de serviço para o backend: **`roles/datastore.user`** (leitura e
   escrita de documentos). Não são necessários papéis de administrador do Firestore no runtime.
   Para publicar regras e índices (pessoa, não o backend): `roles/firebaserules.admin` e
   `roles/datastore.indexAdmin`, ou o papel de proprietário que já existe.
3. `backend/.env`: `DATA_BACKEND=firestore`, `FIREBASE_PROJECT_ID=mundo-das-patas---dev`,
   `FIRESTORE_DATABASE_ID=(default)`, sem `FIRESTORE_EMULATOR_HOST`.
4. Publicar regras e índices — **somente com aprovação**, revisando antes:

   ```powershell
   firebase deploy --only firestore:rules,firestore:indexes --project mundo-das-patas---dev
   ```

### Validar a conectividade sem expor credenciais

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m scripts.firestore_check          # SOMENTE LEITURA: projeto, banco, modo, origem das credenciais, contagens
```

O script mostra a origem das credenciais (nunca valores ou caminhos) e só **conta** documentos.

### Smoke test de escrita (exige aprovação explícita do proprietário)

```powershell
python -m scripts.firestore_check --write-probe --confirm-project mundo-das-patas---dev
```

Numa transação cria `_smoke_tests/{id-aleatório}`, lê de volta e apaga. Não toca nas coleções de
negócio nem cria dados de demonstração. Sem `--confirm-project` idêntico ao projeto configurado, recusa.
Depois, um teste funcional pela API (criar uma categoria real definida pelo cliente) pode ser feito
no painel quando a TASK 06C ligar o frontend à API.

### Smoke funcional pelo painel e limpeza da execução (TASK 06G)

Os dados fictícios são criados pelo painel com nomes `AUDIT_<run-id>_…`. O script abaixo só aceita o
Firestore real de `mundo-das-patas---dev`, banco `(default)` (recusa emulador e outros projetos):

```powershell
python -m scripts.smoke_run counts                                        # SOMENTE LEITURA: contagens e referências órfãs
python -m scripts.smoke_run discover --run-id AUDIT_<id> --out m.json     # SOMENTE LEITURA: manifesto da execução
python -m scripts.smoke_run cleanup --manifest m.json --confirm-project mundo-das-patas---dev
```

A posse é decidida pelos relacionamentos (categoria com o prefixo → claim → produtos da categoria →
movimentações/vendas desses produtos → idempotência cujo `result_id` aponta para elas), não só pelo
prefixo. `cleanup` relê tudo, exige que o estado atual coincida com o manifesto e só então apaga os IDs
listados (idempotência → movimentações → vendas → produtos → claims → categorias). Qualquer
inconsistência interrompe sem apagar nada. Guarde o manifesto fora do Git (ex.: `.smoke-runs/`).

---

## 6. Plano Spark e limitações

- **Cotas gratuitas diárias** (Spark): 50 mil leituras, 20 mil escritas, 20 mil exclusões, 1 GiB
  armazenado. Uma venda de N itens custa ~N+2 leituras e ~2N+2 escritas; o dashboard lê as vendas
  de 30 dias a cada abertura; catálogo público lê todos os produtos e categorias por requisição
  (cache HTTP/CDN do catálogo é uma otimização futura).
- **TTL não habilitado**: a exclusão automática por TTL exige faturamento. `idempotency_keys` cresce
  ~1 documento por venda/movimentação/cancelamento (≈1–2 KiB; venda de 100 itens ≈ 10 KiB).
  Para uma loja (dezenas de operações/dia) são poucos MiB por ano. A validade é verificada no
  código, então documentos antigos são apenas inertes. Manutenção futura: habilitar a política
  de TTL em `expires_at` (com faturamento) ou uma limpeza manual revisada — nenhuma limpeza
  automática destrutiva foi implementada.
- Backups/PITR não disponíveis no Spark.
- Limites existentes preservados (`limit` até 500 em listas). Paginação por cursor
  (`start_after` em `created_at` + ID) fica para quando o volume crescer.

---

## 7. Pendências

- Aprovação e execução do smoke test real (§5) e publicação de regras/índices.
- TASK 06C: `httpStoreApi` no React, mantendo o modo demonstração no GitHub Pages.
- Seed de desenvolvimento (opcional), restrito ao emulador.
