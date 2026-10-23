#!/usr/bin/env node
/**
 * Runner autocontido dos testes de ponta a ponta (TASK 06E): `npm run test:e2e:emulator`.
 *
 * 1. confere pré-requisitos (Firebase CLI, Java, Python do backend);
 * 2. escolhe portas livres (nunca encerra processos alheios: porta ocupada → usa a próxima livre);
 * 3. sobe Firestore Emulator + Auth Emulator com uma configuração temporária (projeto demo-*);
 * 4. sobe o FastAPI fora de `backend/` (não lê `backend/.env`), sem credenciais Google reais;
 * 5. espera os health checks e confirma que a API usa o emulador;
 * 6. roda `vitest --config vitest.e2e.config.ts` (com `--with-backend`, antes roda `pytest tests_emulator`);
 * 7. encerra somente os processos que iniciou (árvore inteira) e confere que as portas foram liberadas.
 *
 * Funciona no Windows PowerShell (e em Linux/macOS). Logs: pasta temporária impressa no início.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const PROJECT = 'demo-mundo-das-patas-test';
const HOST = '127.0.0.1';
const ADMIN_UID = 'e2e-admin-uid';
const WIN = process.platform === 'win32';
const KEEP_LOGS = process.argv.includes('--keep-logs');
/** Argumentos extras repassados ao Vitest (ex.: `npm run test:e2e:emulator -- --reporter=hanging-process`). */
const WITH_BACKEND = process.argv.includes('--with-backend');
const VITEST_ARGS = process.argv.slice(2).filter((a) => a !== '--keep-logs' && a !== '--with-backend');

const log = (msg) => console.log(`[e2e] ${msg}`);
const fail = (msg) => {
  console.error(`[e2e] ERRO: ${msg}`);
  process.exitCode = 1;
};

/* ------------------------------------------------------------------ segurança */

function assertSafeTarget(env) {
  const problems = [];
  if (!env.FIREBASE_PROJECT_ID?.startsWith('demo-')) problems.push('FIREBASE_PROJECT_ID precisa começar com "demo-".');
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    if (!env[key]) problems.push(`${key} ausente.`);
    else if (!env[key].startsWith(`${HOST}:`)) problems.push(`${key} não aponta para ${HOST}.`);
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT_JSON) problems.push('credenciais Google presentes no ambiente da API.');
  if (problems.length) throw new Error(`execução recusada: ${problems.join(' ')}`);
}

/* ------------------------------------------------------------------ portas */

const isFree = (port) =>
  new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(false));
    srv.listen(port, HOST, () => srv.close(() => done(true)));
  });

const isListening = (port) =>
  new Promise((done) => {
    const s = new Socket();
    const end = (v) => {
      s.destroy();
      done(v);
    };
    s.setTimeout(500, () => end(false));
    s.once('error', () => end(false));
    s.connect(port, HOST, () => end(true));
  });

async function pickPort(preferred, taken) {
  for (let p = preferred; p < preferred + 50; p++) {
    if (taken.has(p)) continue;
    if (await isFree(p)) {
      taken.add(p);
      if (p !== preferred) log(`porta ${preferred} ocupada por outro processo (mantido); usando ${p}`);
      return p;
    }
  }
  throw new Error(`nenhuma porta livre a partir de ${preferred}`);
}

async function waitFor(what, check, timeoutMs, isAlive) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isAlive && !isAlive()) throw new Error(`${what}: o processo terminou antes de ficar pronto (ver logs)`);
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: tempo esgotado (${timeoutMs / 1000}s)`);
}

/* ------------------------------------------------------------------ processos */

const started = [];

function start(name, command, args, { cwd, env, logFile }) {
  const out = openSync(logFile, 'a');
  // Sem shell (argumentos intactos). Windows: a árvore (ex.: node → java) é encerrada com taskkill /T.
  // Outros sistemas: grupo de processos próprio (`detached`) encerrado com kill(-pid).
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, out], detached: !WIN, windowsHide: true });
  const entry = { name, child, exited: false };
  child.once('exit', () => (entry.exited = true));
  started.push(entry);
  log(`${name} iniciado (pid ${child.pid})`);
  return entry;
}

function killTree(entry) {
  if (entry.exited || !entry.child.pid) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      /* já terminou */
    }
  }
}

let cleaned = false;
async function cleanup(ports) {
  if (cleaned) return;
  cleaned = true;
  for (const entry of [...started].reverse()) killTree(entry);
  // Comprova o encerramento: os processos saíram e as portas que eles ocupavam estão livres.
  const until = Date.now() + 20_000;
  let busy = [];
  while (Date.now() < until) {
    busy = [];
    for (const p of ports) if (await isListening(p)) busy.push(p);
    if (!busy.length && started.every((e) => e.exited)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (busy.length) fail(`portas ainda ocupadas após o encerramento: ${busy.join(', ')}`);
  else if (!started.every((e) => e.exited)) fail(`processos que não terminaram: ${started.filter((e) => !e.exited).map((e) => e.name).join(', ')}`);
  else log(`encerramento conferido: ${started.length} processo(s) finalizado(s), portas ${ports.join(', ')} livres`);
}

/* ------------------------------------------------------------------ execução */

/** Script JS do Firebase CLI (instalação global do npm), executado diretamente pelo Node, sem shell. */
function firebaseCli() {
  const candidates = [process.env.FIREBASE_TOOLS_JS, join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js')];
  if (WIN && process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'));
  for (const prefix of ['/usr/local/lib', '/usr/lib']) candidates.push(join(prefix, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'));
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Firebase CLI (firebase-tools) não encontrado: npm install -g firebase-tools (ou defina FIREBASE_TOOLS_JS)');
  return found;
}

function prerequisites() {
  // Executáveis chamados sem shell: argumentos chegam intactos.
  const check = (label, cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${label} não encontrado (${cmd} ${args.join(' ')})`);
    return (r.stdout || r.stderr).trim().split('\n')[0];
  };
  const firebase = firebaseCli();
  log(`Firebase CLI ${check('Firebase CLI', process.execPath, [firebase, '--version'])}`);
  log(`Java: ${check('Java (Firestore Emulator)', 'java', ['-version'])}`);
  const python = WIN ? join(BACKEND, '.venv', 'Scripts', 'python.exe') : join(BACKEND, '.venv', 'bin', 'python');
  if (!existsSync(python)) throw new Error(`Python do backend não encontrado em ${python} (ver backend/README.md §1)`);
  check('uvicorn no venv do backend', python, ['-c', 'import uvicorn, firebase_admin']);
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) throw new Error('vitest não instalado (npm install)');
  return { python, firebase, vitest };
}

async function main() {
  let python, firebase, vitestBin;
  try {
    ({ python, firebase, vitest: vitestBin } = prerequisites());
  } catch (error) {
    return fail(`pré-requisito ausente: ${error.message}`);
  }
  const taken = new Set();
  const ports = {
    firestore: await pickPort(8181, taken),
    firestoreWs: await pickPort(9150, taken),
    auth: await pickPort(9099, taken),
    hub: await pickPort(4400, taken),
    logging: await pickPort(4500, taken),
    api: await pickPort(8010, taken),
  };
  const ownedPorts = Object.values(ports);
  const work = mkdtempSync(join(tmpdir(), 'mdp-e2e-'));
  const emptyGcloud = join(work, 'gcloud-vazio');
  mkdirSync(emptyGcloud);
  log(`pasta de trabalho e logs: ${work}`);

  const onSignal = async () => {
    log('interrompido: encerrando serviços…');
    await cleanup(ownedPorts);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const firebaseConfig = {
      firestore: { rules: join(ROOT, 'firestore.rules') },
      emulators: {
        singleProjectMode: true,
        firestore: { host: HOST, port: ports.firestore, websocketPort: ports.firestoreWs },
        auth: { host: HOST, port: ports.auth },
        hub: { host: HOST, port: ports.hub },
        logging: { host: HOST, port: ports.logging },
        ui: { enabled: false },
      },
    };
    writeFileSync(join(work, 'firebase.json'), JSON.stringify(firebaseConfig, null, 2));

    // Ambiente sem credenciais reais: sem GOOGLE_APPLICATION_CREDENTIALS e com uma pasta gcloud vazia
    // (o ADC do usuário não é encontrado). Os emuladores não exigem credenciais.
    const baseEnv = { ...process.env, CLOUDSDK_CONFIG: emptyGcloud };
    for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'FIREBASE_CONFIG']) delete baseEnv[k];

    const emulators = start('emuladores', process.execPath, [firebase, 'emulators:start', '--only', 'firestore,auth', '--project', PROJECT, '--config', join(work, 'firebase.json')], {
      cwd: work,
      env: baseEnv,
      logFile: join(work, 'emulators.log'),
    });
    await waitFor(
      'emuladores',
      async () => readFileSync(join(work, 'emulators.log'), 'utf8').includes('All emulators ready') && (await isListening(ports.firestore)) && (await isListening(ports.auth)),
      120_000,
      () => !emulators.exited,
    );
    log(`emuladores prontos (Firestore ${HOST}:${ports.firestore}, Auth ${HOST}:${ports.auth})`);

    if (WITH_BACKEND) {
      log('executando os testes do backend no Firestore Emulator (pytest tests_emulator)…');
      const pytest = spawnSync(python, ['-m', 'pytest', 'tests_emulator', '-q'], {
        cwd: BACKEND,
        env: { ...baseEnv, FIRESTORE_EMULATOR_HOST: `${HOST}:${ports.firestore}` },
        stdio: 'inherit',
      });
      if (pytest.status !== 0) fail(`testes do backend no emulador falharam (código ${pytest.status})`);
      else log('testes do backend no emulador aprovados');
    }

    const apiEnv = {
      ...baseEnv,
      APP_ENV: 'test',
      LOG_LEVEL: 'WARNING',
      DATA_BACKEND: 'firestore',
      FIREBASE_PROJECT_ID: PROJECT,
      FIRESTORE_DATABASE_ID: '(default)',
      FIRESTORE_EMULATOR_HOST: `${HOST}:${ports.firestore}`,
      FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${ports.auth}`,
      ADMIN_ALLOWED_UIDS: ADMIN_UID,
      CORS_ORIGINS: '',
    };
    assertSafeTarget(apiEnv);
    // cwd fora de backend/: o arquivo backend/.env (que aponta para o projeto real) não é lido.
    const api = start('FastAPI', python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', BACKEND, '--host', HOST, '--port', String(ports.api)], {
      cwd: work,
      env: apiEnv,
      logFile: join(work, 'api.log'),
    });
    const apiUrl = `http://${HOST}:${ports.api}`;
    let health;
    await waitFor(
      'FastAPI',
      async () => {
        try {
          health = await (await fetch(`${apiUrl}/health`)).json();
          return true;
        } catch {
          return false;
        }
      },
      60_000,
      () => !api.exited,
    );
    if (health?.dependencies?.database?.status !== 'emulator') throw new Error('a API não confirmou o uso do Firestore Emulator: abortado antes dos testes');
    log(`FastAPI pronto em ${apiUrl} (database: emulator, environment: ${health.environment})`);

    const testEnv = {
      ...baseEnv,
      E2E_API_URL: apiUrl,
      E2E_PROJECT_ID: PROJECT,
      FIRESTORE_EMULATOR_HOST: apiEnv.FIRESTORE_EMULATOR_HOST,
      FIREBASE_AUTH_EMULATOR_HOST: apiEnv.FIREBASE_AUTH_EMULATOR_HOST,
    };
    log('executando os testes de ponta a ponta…');
    const vitest = spawnSync(process.execPath, [vitestBin, 'run', '--config', 'vitest.e2e.config.ts', ...VITEST_ARGS], { cwd: ROOT, env: testEnv, stdio: 'inherit' });
    if (vitest.status !== 0) fail(`testes de ponta a ponta falharam (código ${vitest.status})`);
    else log('testes de ponta a ponta aprovados');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    log(`logs mantidos em ${work}`);
  } finally {
    await cleanup(ownedPorts);
    if (process.exitCode !== 1 && !KEEP_LOGS) {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        log(`não foi possível apagar ${work} (arquivo em uso); pode ser removida depois`);
      }
    }
  }
}

await main();
