# Fotos dos produtos — Cloud Storage for Firebase (TASK 07A)

O navegador **nunca** fala com o Storage para escrever. O painel envia a foto ao FastAPI, que
confere a sessão (Firebase Authentication + `ADMIN_ALLOWED_UIDS`), valida e recodifica a imagem e
grava no bucket com o Admin SDK. A vitrine só **lê** as fotos, por URL pública com token de download.

Sumário: [Arquitetura](#1-arquitetura) · [Configuração](#2-configuração) · [Regras](#3-regras-storagerules) ·
[Emulador](#4-storage-emulator) · [Limpeza de órfãos](#5-limpeza-de-órfãos) · [Vercel](#6-compatibilidade-com-a-vercel) ·
[Storage real](#7-ativar-no-projeto-real-mundo-das-patas---dev) · [Limitações](#8-limitações-conhecidas)

---

## 1. Arquitetura

```
Painel (React)                         FastAPI                                   Storage / Firestore
 escolhe foto ──► compressão no navegador
 (JPEG/PNG/WebP ≤ 8 MB)  WebP ≤ 1200 px, ~900 KB
 salva o produto ───────────────────► POST/PUT /admin/products   ─────────────► products/{id}
 envia a foto (corpo binário) ──────► PUT /admin/products/{id}/image
                                        1. token + allowlist (antes de ler o corpo)
                                        2. Content-Type JPEG/PNG/WebP, ≤ 2 MiB (413/415)
                                        3. Pillow: assinatura, dimensões, decodificação completa
                                        4. recodifica WebP (sem EXIF/metadados, ≤ 1600 px)
                                        5. grava products/{id}/images/{uuid}.webp ──► bucket
                                        6. transação: image_url + image_path ─────► products/{id}
                                        7. apaga a foto anterior (se for deste produto)
 vitrine (sem login) ◄──── imageUrl ── GET /public/products  ◄─── https://firebasestorage.googleapis.com/v0/b/…?alt=media&token=…
```

- **Caminho** decidido no servidor: `products/{productId}/images/{imageId}.webp`, `imageId` aleatório
  de 128 bits. Nada do caminho vem do navegador; o ID do produto da URL só é aceito se existir.
- **Firestore** guarda só `image_url` (pública) e `image_path` (interno, nunca exposto). Nunca bytes nem Base64.
- **Produto novo:** o produto é salvo primeiro (ID definitivo) e a foto depois. Se a foto falhar, o
  produto continua salvo, o formulário segue aberto em modo de edição e a mensagem diz que a foto
  não foi enviada.
- **Troca:** a nova foto é gravada, o produto passa a apontar para ela numa transação e só então a
  anterior é apagada — e só se o caminho lido na transação estiver no prefixo do próprio produto.
  Falha no envio mantém a foto anterior. Falha ao gravar o produto apaga o objeto recém-enviado
  (depois de reler o produto); resultado incerto mantém o objeto (a limpeza de órfãos resolve).
- **Remoção:** `DELETE /admin/products/{id}/image` limpa o produto e apaga o objeto, com a mesma
  prova de posse.
- `image_url` não é mais aceito em `POST/PUT /admin/products` (422): fotos só pelas rotas próprias.
  URLs antigas continuam sendo exibidas e podem ser removidas.
- Sem envio de foto disponível (`GET /admin/images/config` → `available: false`), o formulário avisa
  e permite salvar o produto sem foto. Não existe fallback local silencioso.
- O `fetch` não informa progresso de envio: o formulário mostra a etapa (compactando, salvando,
  enviando) com indicador indeterminado.
- Logout durante o envio cancela a requisição (sinal da sessão, TASK 06E); respostas tardias são ignoradas.

| Resposta | Quando |
| --- | --- |
| `401` / `403` | sem token / UID fora da allowlist (antes de ler o corpo) |
| `404` | produto inexistente (nenhum objeto é criado) |
| `413 payload_too_large` | corpo > 2 MiB (`Content-Length` ou leitura em fluxo) |
| `415` | tipo diferente de JPEG/PNG/WebP (SVG, HTML, PDF…) |
| `422 invalid_image` | conteúdo não confere com o tipo, imagem corrompida, animada, dimensões fora do limite |
| `503 storage_unavailable` | Storage desligado, mal configurado, combinação recusada ou fora do ar (prazo de ~8 s para novas tentativas) |

---

## 2. Configuração

Variáveis do backend (`backend/.env.example`):

| Variável | Valores |
| --- | --- |
| `IMAGE_STORAGE` | `disabled` (padrão) ou `firebase` |
| `FIREBASE_STORAGE_BUCKET` | **exatamente** `<FIREBASE_PROJECT_ID>.firebasestorage.app` (ex.: `mundo-das-patas---dev.firebasestorage.app`) |
| `FIREBASE_STORAGE_EMULATOR_HOST` | `127.0.0.1:9199` — **só** com o emulador; proibido em staging/produção |

Combinações recusadas (fail-closed, `503`, em qualquer `APP_ENV`):

- Storage Emulator com o Firestore **real** (URLs do emulador iriam para o banco real);
- Storage **real** com `DATA_BACKEND=memory` ou com o Firestore Emulator;
- Storage real com a variável `STORAGE_EMULATOR_HOST` no ambiente (a biblioteca desviaria as chamadas);
- staging/produção com `FIREBASE_STORAGE_EMULATOR_HOST`, ou com `IMAGE_STORAGE=firebase` sem bucket
  (a aplicação nem inicia).

### Isolamento entre projetos (TASK 07B.1)

Conferido em `check_storage_config` antes de criar o cliente, antes de ler o produto ou abrir
transação (envio, troca, remoção, limpeza) e de novo antes de cada operação no bucket:

- **Bucket:** só o padrão do próprio projeto, `<FIREBASE_PROJECT_ID>.firebasestorage.app` — também no
  emulador (`demo-…firebasestorage.app`). Bucket de outro projeto, legado `.appspot.com` (o projeto
  não tem), sufixos ou prefixos extras: `503` e nada é gravado no Storage nem no Firestore.
  O nome nunca vem da requisição.
- **`FIREBASE_SERVICE_ACCOUNT_JSON`:** `project_id` igual a `FIREBASE_PROJECT_ID`, senão o Storage real
  é recusado (e staging/produção nem iniciam). O conteúdo nunca é registrado.
- **ADC:** se `GOOGLE_APPLICATION_CREDENTIALS` apontar para uma conta de serviço, o `project_id` dela
  precisa ser o do projeto; arquivo ilegível é recusado. ADC de usuário (`gcloud auth application-default
  login`, tipo `authorized_user`) **não identifica projeto**: é aceito, e `quota_project_id` é ignorado
  (é só o projeto de cota/cobrança, não prova de posse). Também não identificam projeto offline:
  `impersonated_service_account`, `external_account` e o servidor de metadados. Nesses casos, a barreira
  é o nome do bucket mais o IAM, e a posse é conferida na ativação (§7).

`GET /health` informa `storage.status` = `disabled`, `emulator`, `configured` ou `not_configured`,
sem testar a conexão.

---

## 3. Regras (`storage.rules`)

Deny-all: nenhum acesso direto pelo SDK do navegador (nem leitura, listagem, envio ou exclusão),
autenticado ou não. O Admin SDK do FastAPI ignora as regras. A vitrine lê as fotos pelas URLs com
token de download (`firebaseStorageDownloadTokens`), que o serviço de download do Firebase aceita
independentemente das regras. Quem tem a URL vê a foto — ela é tratada como pública (são fotos de
catálogo). Não há listagem pública do bucket.

O Storage Emulator confirma: sem token, token errado, listagem, envio e exclusão diretos → `403`.

---

## 4. Storage Emulator

`npm run test:integration:emulator` sobe Firestore + Auth + Storage em portas livres, com projeto
`demo-*` (que só existe no emulador), e roda os testes de integração e E2E. O runner recusa alvos
não-loopback, remove credenciais reais do ambiente filho e encerra apenas os processos que iniciou.

Conferência visual (painel e vitrine no navegador, tudo nos emuladores):

```powershell
node scripts/e2e-emulator.mjs --serve
# abre http://127.0.0.1:<porta>/MundoDasPatas/#/admin — login admin@e2e.test / senha-e2e-123
# Ctrl+C encerra emuladores, API e Vite
```

---

## 5. Limpeza de órfãos

Objetos sem produto que aponte para eles (envio interrompido, resultado incerto) são removidos pelo
script, que por padrão só **relata**:

```powershell
cd backend
python -m scripts.storage_cleanup                                     # simulação
python -m scripts.storage_cleanup --apply --confirm-bucket <BUCKET>   # exclui
python -m scripts.storage_cleanup --product <ID>                      # um produto
```

Só considera `products/{id}/images/{uuid}.webp` com metadado `productId` igual ao do caminho, que
não sejam a foto atual do produto e criados há mais de 1 hora. Qualquer outro objeto é ignorado.

---

## 6. Compatibilidade com a Vercel

- Corpo de requisição das Functions limitado a 4,5 MB: o FastAPI aceita no máximo 2 MiB e o
  navegador compacta antes (WebP ≤ 1200 px, alvo ~900 KB). Sem multipart.
- Pillow tem wheels para Linux x86_64; cabe com folga no limite de pacote Python.
- Credenciais via `FIREBASE_SERVICE_ACCOUNT_JSON` (variável secreta); nenhuma variável `VITE_*` nova.
- Modos do frontend:
  - **demo** (GitHub Pages): `localStoreApi`, fotos como data URL no `localStorage`, sem Firebase,
    Storage nem backend — inalterado.
  - **API com Storage indisponível**: formulário avisa, produto salva sem foto, erro claro (`503`).
  - **API com Storage Emulator**: `--serve` / testes de integração.
  - **API com Storage real**: preparado (§7), não ativado.

---

## 7. Ativar no projeto real (`mundo-das-patas---dev`)

Nada disto foi feito na TASK 07A. Todas as etapas são do proprietário da conta:

1. **Plano Blaze.** Buckets novos do Cloud Storage for Firebase exigem o plano Blaze (conta de
   faturamento). O Blaze mantém uma cota sem custo para buckets em `US-CENTRAL1`, `US-EAST1` ou
   `US-WEST1`; confira os preços vigentes e configure alertas de orçamento antes.
2. **Criar o bucket padrão** (Console → Storage → Começar), na mesma região do Firestore quando
   possível. O nome será `mundo-das-patas---dev.firebasestorage.app`.
3. **Publicar as regras** deny-all: `firebase deploy --only storage --project mundo-das-patas---dev`
   (não altera `firestore.rules`).
4. **Conta de serviço** usada pelo backend: papel com escrita de objetos no bucket (a conta padrão
   do Admin SDK já tem; para conta dedicada, `Storage Object Admin` restrito ao bucket).
5. **Backend:** `IMAGE_STORAGE=firebase`, `FIREBASE_STORAGE_BUCKET=mundo-das-patas---dev.firebasestorage.app`,
   com `DATA_BACKEND=firestore` real e **sem** `FIREBASE_STORAGE_EMULATOR_HOST`/`STORAGE_EMULATOR_HOST`.
6. **Conferir a posse do bucket** (somente leitura, antes do primeiro envio; não é feito pela API em
   tempo de execução porque exigiria `storage.buckets.get`, permissão que a conta de serviço de
   objetos não precisa ter):
   ```powershell
   gcloud storage buckets describe gs://mundo-das-patas---dev.firebasestorage.app --format="value(project_number)"
   gcloud projects describe mundo-das-patas---dev --format="value(projectNumber)"   # os dois iguais
   ```
   No Console do Firebase (Storage) o bucket aparece como **padrão** do projeto; e
   `gcloud storage buckets get-iam-policy gs://…` deve mostrar a identidade do backend só com acesso a objetos.
7. **Validar:** `GET /health` → `storage: configured`; enviar uma foto pelo painel; abrir a vitrine
   sem login; trocar e remover; rodar `python -m scripts.storage_cleanup` (simulação).

CORS do bucket não é necessário: as fotos são exibidas por `<img>` e o envio passa pelo FastAPI.

---

## 8. Limitações conhecidas

- O emulador não honra `if_generation_match=0` no envio (sobrescreve). A unicidade vem do `imageId`
  aleatório de 128 bits; a pré-condição não é usada.
- O emulador responde `403` para objeto apagado acessado por token; o serviço real responde `404`.
- Não comprovados no emulador: IAM, CORS do bucket, cache/CDN do Firebase.
- Fotos têm `Cache-Control: public, max-age=31536000, immutable`; cada troca gera caminho novo, então
  não há conteúdo velho em cache. Uma URL removida pode continuar em caches de navegador.
- Sem progresso real de envio (limitação do `fetch`).
