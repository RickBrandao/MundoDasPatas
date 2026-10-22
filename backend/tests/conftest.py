import os

# Antes de importar a aplicação: os testes nunca usam a configuração da máquina do desenvolvedor.
os.environ["APP_ENV"] = "test"
os.environ["DATA_BACKEND"] = "memory"

from collections.abc import Iterator  # noqa: E402
from datetime import UTC, datetime, timedelta  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.dependencies import get_token_verifier  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.core.security import InvalidToken, VerifiedToken  # noqa: E402
from app.domain.models import Category, Product, StoreSettings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.repositories.base import Repositories  # noqa: E402
from app.repositories.firestore import create_firestore_repositories  # noqa: E402
from app.repositories.memory import MemoryState, create_memory_repositories  # noqa: E402

ADMIN_UID = "admin-uid-1"
USER_UID = "user-uid-1"
ADMIN = {"Authorization": "Bearer token-admin"}
USER = {"Authorization": "Bearer token-user"}

_ENV_VARS = (
    "FIREBASE_PROJECT_ID",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIRESTORE_DATABASE_ID",
    "FIREBASE_AUTH_EMULATOR_HOST",
    # Os testes unitários nunca alcançam um Firestore (real ou emulador): ver tests_emulator/.
    "FIRESTORE_EMULATOR_HOST",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "ADMIN_ALLOWED_UIDS",
    "CORS_ORIGINS",
    "LOG_LEVEL",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {"app_env": "test", "data_backend": "memory"} | overrides
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


class FakeVerifier:
    """Substitui o Firebase nos testes. Só é ativado explicitamente via `dependency_overrides`."""

    def __init__(self, tokens: dict[str, VerifiedToken]) -> None:
        self.tokens = tokens
        self.calls: list[str] = []

    def verify(self, id_token: str) -> VerifiedToken:
        self.calls.append(id_token)
        if id_token not in self.tokens:
            raise InvalidToken()
        return self.tokens[id_token]


def default_verifier() -> FakeVerifier:
    return FakeVerifier(
        {
            "token-admin": VerifiedToken(uid=ADMIN_UID, claims={"uid": ADMIN_UID}),
            # Claim "admin" no token NÃO concede acesso: só a allowlist do servidor vale.
            "token-user": VerifiedToken(uid=USER_UID, claims={"uid": USER_UID, "admin": True, "role": "admin"}),
        }
    )


def build_client(settings: Settings | None = None, repos: Repositories | None = None, verifier: Any = None) -> TestClient:
    settings = settings or make_settings(firebase_project_id="demo-test", admin_allowed_uids=ADMIN_UID)
    app: FastAPI = create_app(settings, repos)
    if verifier is not None:
        app.dependency_overrides[get_token_verifier] = lambda: verifier
    return TestClient(app, raise_server_exceptions=False)


class UnreachableFirestore:
    """Cliente falso do Firestore em que toda chamada falha como uma rede indisponível."""

    def __init__(self, error: Exception | None = None) -> None:
        from google.api_core import exceptions as gexc

        self.error = error or gexc.ServiceUnavailable("connect failed: 10.0.0.1 token=SEGREDO")

    def __getattr__(self, name: str) -> Any:
        def fail(*_: Any, **__: Any) -> Any:
            raise self.error

        return fail


def unreachable_firestore_repos(settings: Settings, error: Exception | None = None) -> Repositories:
    client = UnreachableFirestore(error)
    return create_firestore_repositories(settings, client=lambda: client)  # type: ignore[arg-type,return-value]


@pytest.fixture
def state() -> MemoryState:
    return MemoryState()


@pytest.fixture
def repos(state: MemoryState) -> Repositories:
    return create_memory_repositories(state)


@pytest.fixture
def client(repos: Repositories) -> Iterator[TestClient]:
    with build_client(repos=repos, verifier=default_verifier()) as c:
        yield c


# --------------------------------------------------------------------- dados de exemplo

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


def category(id: str, name: str, active: bool = True) -> Category:
    return Category(id=id, name=name, icon="label", active=active)


def product(id: str, **overrides: Any) -> Product:
    base: dict[str, Any] = {
        "id": id,
        "name": f"Produto {id}",
        "description": "Descrição",
        "category_id": "racoes",
        "brand": "Marca",
        "image_url": "",
        "price_cents": 4990,
        "show_price": True,
        "stock": 10,
        "min_stock": 2,
        "published": True,
        "featured": False,
        "archived": False,
        "created_at": NOW - timedelta(days=10),
        "updated_at": NOW - timedelta(days=1),
    }
    return Product(**(base | overrides))


def seed(state: MemoryState, settings: StoreSettings | None = None) -> None:
    state.categories.update(
        {
            c.id: c
            for c in [
                category("racoes", "Rações"),
                category("brinquedos", "Brinquedos"),
                category("inativa", "Inativa", active=False),
            ]
        }
    )
    state.products.update(
        {
            p.id: p
            for p in [
                product("p1", featured=True),
                product("p2", price_cents=None, show_price=False),
                product("p3", show_price=False, price_cents=1990),
                product("oculto", published=False),
                product("arquivado", archived=True, published=False),
                product("cat-inativa", category_id="inativa"),
                product("esgotado", stock=0),
                product("brinquedo", category_id="brinquedos", stock=1, min_stock=3),
            ]
        }
    )
    if settings:
        state.settings = settings
