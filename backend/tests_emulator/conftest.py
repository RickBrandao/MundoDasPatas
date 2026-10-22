"""Testes de integração contra o Firestore Emulator (nunca contra um projeto real).

Execução (ver backend/README.md, "Firestore Emulator"):

    firebase emulators:start --only firestore --project demo-mundo-das-patas-test   # na raiz do repositório
    $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8181"; python -m pytest tests_emulator

Travas antes de qualquer escrita ou limpeza (a sessão é interrompida se alguma falhar):
- `FIRESTORE_EMULATOR_HOST` definido, sem protocolo e apontando para loopback;
- o endereço responde como o emulador do Firestore (não basta APP_ENV=test);
- o projeto usado é `demo-*` (projetos "demo-" não existem no Google Cloud; só o emulador os aceita)
  e nunca o projeto real;
- o cliente criado está de fato em modo emulador (canal local, credenciais anônimas).
A limpeza usa o endpoint REST exclusivo do emulador (`/emulator/v1/...`), inexistente na produção.
"""

import os
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.domain.catalog import normalize_text
from app.repositories import firestore_codec as codec
from app.repositories.base import Repositories
from app.repositories.firestore import create_firestore_repositories
from tests.conftest import ADMIN_UID, build_client, default_verifier, make_settings

EMULATOR_PROJECT = "demo-mundo-das-patas-test"
REAL_PROJECTS = {"mundo-das-patas---dev"}
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _emulator_host() -> str:
    host = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
    if not host:
        pytest.exit("FIRESTORE_EMULATOR_HOST não definido: inicie o emulador (ver README). Nada foi executado.", 2)
    if "://" in host:
        pytest.exit("FIRESTORE_EMULATOR_HOST deve ser host:porta, sem http://.", 2)
    if host.rsplit(":", 1)[0] not in LOOPBACK:
        pytest.exit(f"FIRESTORE_EMULATOR_HOST precisa ser loopback (recebido {host!r}).", 2)
    return host


def _http(method: str, url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, method=method)  # noqa: S310 - URL loopback validada acima
    with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
        return resp.status, resp.read().decode()


@pytest.fixture(scope="session")
def emulator_host() -> str:
    host = _emulator_host()
    assert EMULATOR_PROJECT.startswith("demo-") and EMULATOR_PROJECT not in REAL_PROJECTS
    try:
        status, body = _http("GET", f"http://{host}/")
    except OSError as exc:
        pytest.exit(f"Emulador do Firestore inacessível em {host} ({type(exc).__name__}). Nada foi executado.", 2)
    if status != 200 or body.strip() != "Ok":
        pytest.exit(f"{host} não respondeu como o Firestore Emulator. Nada foi executado.", 2)
    return host


@pytest.fixture(scope="session")
def fs_settings(emulator_host: str) -> Settings:
    settings = make_settings(
        data_backend="firestore", firebase_project_id=EMULATOR_PROJECT, admin_allowed_uids=f"{ADMIN_UID},admin-uid-2"
    )
    assert settings.firestore_emulator_host == emulator_host
    return settings


def clear_emulator(host: str) -> None:
    url = f"http://{host}/emulator/v1/projects/{EMULATOR_PROJECT}/databases/(default)/documents"
    status, _ = _http("DELETE", url)
    assert status == 200


@pytest.fixture
def new_repos(fs_settings: Settings) -> Callable[[], Repositories]:
    """Cada chamada cria repositórios com cliente próprio — como outra instância do servidor."""

    def make() -> Repositories:
        repos = create_firestore_repositories(fs_settings)
        client = repos.products._client()  # type: ignore[attr-defined]
        # Confirma a conexão efetiva ao emulador antes de qualquer operação.
        assert client._emulator_host == fs_settings.firestore_emulator_host
        assert client.project == EMULATOR_PROJECT
        assert type(client._credentials).__name__ == "AnonymousCredentials"
        return repos

    return make


@pytest.fixture
def repos(emulator_host: str, new_repos: Callable[[], Repositories]) -> Iterator[Repositories]:
    clear_emulator(emulator_host)
    yield new_repos()


@pytest.fixture
def db(repos: Repositories) -> Any:
    """Cliente cru do Firestore (emulador) para preparar dados e inspecionar documentos."""
    return repos.products._client()  # type: ignore[attr-defined]


@pytest.fixture
def client(fs_settings: Settings, repos: Repositories) -> Iterator[TestClient]:
    with build_client(fs_settings, repos, verifier=default_verifier()) as c:
        yield c


def put_docs(db: Any, *, categories: Any = (), products: Any = ()) -> None:
    for c in categories:
        db.collection("categories").document(c.id).set(codec.category_to_doc(c))
        key = normalize_text(c.name)
        db.collection("category_name_claims").document(codec.category_claim_id(key)).set(codec.claim_to_doc(c.id, key))
    for p in products:
        db.collection("products").document(p.id).set(codec.product_to_doc(p))


def count(db: Any, collection: str) -> int:
    return len(list(db.collection(collection).stream()))


def pytest_terminal_summary(terminalreporter: Any) -> None:
    from tests_emulator.test_inventory import BUSY_RETRIES

    if BUSY_RETRIES:
        terminalreporter.write_line(
            f"Corridas concorrentes: {len(BUSY_RETRIES)}; repetições após 503 database_busy: {sum(BUSY_RETRIES)} {BUSY_RETRIES}"
        )
