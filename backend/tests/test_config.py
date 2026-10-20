import pytest
from pydantic import ValidationError

from app.core.config import AppEnv, DataBackend
from tests.conftest import make_settings

PROD_OK = {
    "app_env": "production",
    "data_backend": "firestore",
    "firebase_project_id": "mdp-prod",
    "cors_origins": "https://mundodaspatas.com.br",
}


def test_local_defaults_do_not_require_firebase() -> None:
    s = make_settings(app_env="local")
    assert s.app_env is AppEnv.LOCAL
    assert s.data_backend is DataBackend.MEMORY
    assert not s.firebase_configured
    assert s.admin_allowed_uids == frozenset()
    assert s.firestore_database_id == "(default)"


def test_csv_lists_are_parsed() -> None:
    s = make_settings(cors_origins="http://localhost:5173, https://a.example", admin_allowed_uids="u1, u2,,")
    assert s.cors_origins == ["http://localhost:5173", "https://a.example"]
    assert s.admin_allowed_uids == frozenset({"u1", "u2"})


def test_csv_lists_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALLOWED_UIDS", "abc,def")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
    s = make_settings()
    assert s.admin_allowed_uids == frozenset({"abc", "def"})
    assert s.cors_origins == ["http://localhost:5173"]


def test_valid_production_config() -> None:
    s = make_settings(**PROD_OK)
    assert s.is_deployed
    assert not s.docs_enabled


@pytest.mark.parametrize(
    ("override", "fragment"),
    [
        ({"data_backend": "memory"}, "DATA_BACKEND=memory"),
        ({"firebase_project_id": None}, "FIREBASE_PROJECT_ID"),
        ({"firebase_auth_emulator_host": "localhost:9099"}, "FIREBASE_AUTH_EMULATOR_HOST"),
        ({"cors_origins": "*"}, "'*'"),
        ({"cors_origins": "http://mundodaspatas.com.br"}, "https://"),
    ],
)
def test_production_rejects_insecure_config(override: dict[str, object], fragment: str) -> None:
    with pytest.raises(ValidationError, match=fragment):
        make_settings(**(PROD_OK | override))


def test_staging_also_fails_closed() -> None:
    with pytest.raises(ValidationError, match="FIREBASE_PROJECT_ID"):
        make_settings(app_env="staging", data_backend="firestore")


def test_staging_allows_http_origins_for_homologation() -> None:
    s = make_settings(**(PROD_OK | {"app_env": "staging", "cors_origins": "http://localhost:5173"}))
    assert s.cors_origins == ["http://localhost:5173"]


@pytest.mark.parametrize("origin", ["localhost:5173", "https://site.example/"])
def test_invalid_cors_origin(origin: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(cors_origins=origin)


def test_service_account_secret_is_not_exposed_in_repr() -> None:
    s = make_settings(firebase_service_account_json='{"private_key": "SEGREDO"}')
    assert "SEGREDO" not in repr(s)
    assert "SEGREDO" not in str(s.model_dump())


def test_unknown_env_is_rejected() -> None:
    with pytest.raises(ValidationError):
        make_settings(app_env="prod")
