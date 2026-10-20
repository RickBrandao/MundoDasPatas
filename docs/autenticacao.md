# Autenticação administrativa (TASK 05B)

Login do painel com **Firebase Authentication** e autorização confirmada pelo **FastAPI**.
Os dados do painel **continuam demonstrativos** (salvos no navegador): a integração com o
Firestore é a TASK 06/07.

## 1. Como funciona

```
Navegador (React)                     Firebase Authentication          FastAPI
─────────────────                     ───────────────────────          ───────
#/admin/... ──► AdminAuthProvider
                 │ onAuthStateChanged ◄──── sessão restaurada (aba)
                 │ signInWithEmailAndPassword ──► valida e-mail/senha
                 │ getIdToken() ◄──────────────── ID Token (renovado pelo SDK)
                 │ GET /api/v1/admin/me  ──────────────────────────────► require_admin:
                 │   Authorization: Bearer <ID Token>                     assinatura, validade,
                 │                                                        revogação, UID na
                 │ ◄──────────── 200 {uid} · 401 · 403 · 503 ──────────── ADMIN_ALLOWED_UIDS
                 ▼
             AdminGate: só `authorized` monta o painel
```

- **Autenticação ≠ autorização.** Entrar no Firebase não abre o painel: o servidor precisa
  responder `200` em `/admin/me`. O UID vem do token verificado, nunca do navegador.
- **Fail-closed.** Verificando, `403`, `503`, falha de rede, resposta inesperada, SDK que não
  carregou ou configuração incompleta → o painel não é montado.
- **Corridas.** Cada verificação tem um `AbortController`; logout, troca de usuário ou nova
  verificação cancelam a anterior, e respostas de outro usuário são descartadas.
- **Expiração/revogação.** O SDK renova o token sozinho; se a renovação falhar (conta desativada,
  sessão revogada), ele encerra a sessão e o painel fecha. `401` do servidor (após uma tentativa
  com token renovado) também encerra a sessão. Ao voltar para a aba após 5 min, o acesso é
  confirmado de novo.
- **Logout.** Limpa a interface imediatamente, cancela verificações pendentes e chama
  `signOut()`; a navegação direta para `#/admin/*` volta ao login.
- **Esconder botões não é segurança.** A proteção real das operações está no FastAPI
  (`require_admin` em todo o roteador `/api/v1/admin`).

### Persistência da sessão

`browserSessionPersistence`: a sessão sobrevive a recarregamentos, mas **termina ao fechar a
aba/janela**. Escolhida porque o painel pode ser usado em um computador de balcão
compartilhado. Tokens são guardados e renovados pelo SDK — a aplicação nunca grava tokens no
`localStorage`. Para mudar (ex.: manter a sessão entre reinícios), altere
`src/services/auth/firebaseAuthClient.ts` (`browserLocalPersistence`).

## 2. Modos do frontend

| `VITE_ADMIN_AUTH_MODE` | Comportamento |
| --- | --- |
| `demo` (ou ausente) | Painel aberto, dados fictícios, sem Firebase. **GitHub Pages** (o workflow define `demo` explicitamente). O SDK e a configuração do Firebase nem entram no pacote. |
| `firebase` | Login + verificação no FastAPI. Aviso fixo: *"Ambiente de desenvolvimento — dados demonstrativos armazenados neste navegador."* |
| outro valor / `firebase` incompleto | Painel **bloqueado** com a lista das variáveis faltantes (só nomes). Nunca cai para a demo. |

## 3. Configuração local

### Frontend — `.env.local` (raiz, ignorado pelo Git)

Copie `.env.example` e preencha com a configuração **pública** do app Web registrado
(Firebase Console → ⚙ Configurações do projeto → Seus apps → `mundo-das-patas-web-dev`):

```
VITE_ADMIN_AUTH_MODE=firebase
VITE_API_BASE_URL=http://localhost:8000
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
```

A configuração Web não é segredo (vai para o navegador), mas também não é autorização: quem
decide o acesso é o servidor. Não coloque nada do Admin SDK aqui.

### Backend — `backend/.env` (ignorado pelo Git)

```
APP_ENV=local
CORS_ORIGINS=http://localhost:5173
DATA_BACKEND=memory
FIREBASE_PROJECT_ID=<mesmo ID de VITE_FIREBASE_PROJECT_ID>
ADMIN_ALLOWED_UIDS=<UID do administrador>
```

- **UID:** Firebase Console → Authentication → Usuários → coluna "UID do usuário".
- Se usar `http://127.0.0.1:5173` no navegador, acrescente essa origem em `CORS_ORIGINS`
  (separada por vírgula). CORS só libera o navegador a chamar a API; não autoriza ninguém.

### Credenciais do servidor (Firebase Admin SDK)

A verificação de revogação (`check_revoked=True`) consulta o Firebase com credenciais do
servidor. Sem elas, `/admin/me` responde `503` e o painel fica bloqueado.

**Opção recomendada — Application Default Credentials (sem arquivo de chave):**

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project <ID do projeto>
```

A conta Google usada precisa ter acesso ao projeto Firebase (ex.: proprietário).

**Alternativa — conta de serviço:** gere a chave no Console (Configurações do projeto →
Contas de serviço), salve o JSON **fora do repositório** e aponte para ele só na sessão:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\fora-do-repo\mundo-das-patas-dev.json"
```

Nunca versione, envie ao frontend ou cole no chat esse arquivo. O `.gitignore` já bloqueia
nomes comuns (`*service-account*.json`, `*firebase-adminsdk*.json`), mas o lugar dele é fora
da pasta do projeto.

### Domínios autorizados

Firebase Console → Authentication → Configurações → **Domínios autorizados**. Projetos novos
costumam incluir `localhost`, mas **confirme**; `127.0.0.1` não vem por padrão — adicione se for
usá-lo. A lista é exigida por fluxos de redirecionamento/OAuth; para e-mail/senha, verifique também
se a chave de API tem restrições de referenciador HTTP no Google Cloud Console que bloqueiem
`localhost`.

## 4. Smoke test manual (com credenciais reais)

1. `cd backend; .\.venv\Scripts\Activate.ps1; uvicorn app.main:app --reload --port 8000`
2. Confirme <http://localhost:8000/health> → `auth.status = "configured"`.
3. Em outro terminal, na raiz: `npm run dev` (com `VITE_ADMIN_AUTH_MODE=firebase` no `.env.local`).
4. Abra <http://localhost:5173/MundoDasPatas/#/admin> → deve ir para a tela **Entrar**.
5. Entre com o usuário administrativo existente.
6. A tela "Verificando acesso" aparece e, com `200` em `/admin/me`, o painel abre com o aviso
   de ambiente de desenvolvimento. (Na aba Rede do DevTools: `GET /api/v1/admin/me` → 200.)
7. Clique em **Sair** → volta ao login com "Você saiu do painel.".
8. Digite `#/admin/produtos` na barra de endereço → continua no login.

Diagnóstico: `503` = credenciais do servidor/`FIREBASE_PROJECT_ID`; `403` = UID fora de
`ADMIN_ALLOWED_UIDS`; `401` = token de outro projeto (IDs diferentes entre frontend e backend);
erro de CORS no console = `CORS_ORIGINS`.
