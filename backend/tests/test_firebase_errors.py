"""Classificação das falhas do Firebase Admin SDK (SEC-01): 401 identidade inválida, 503 indisponibilidade, 500 inesperado.

Usa a verificação real (`FirebaseTokenVerifier`) e as classes de erro reais do SDK; só a chamada
de rede `verify_id_token` é simulada. Nenhum caso libera o acesso administrativo.
"""

import contextlib
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import firebase_admin
import pytest
from firebase_admin import auth
from firebase_admin import exceptions as fb
from google.auth import exceptions as google_auth
from pydantic import ValidationError

from app.core import security
from app.core.firebase import APP_NAME, FirebaseInitFailed, get_firebase_app
from tests.conftest import ADMIN_UID, build_client, make_settings

TOKEN = "tok-SECRETO-123"
DETAIL = "DETALHE-SENSIVEL"
URL = "/api/v1/admin/products"


@pytest.fixture(autouse=True)
def _no_firebase_app() -> Iterator[None]:
    def drop() -> None:
        with contextlib.suppress(ValueError):  # app não inicializado
            firebase_admin.delete_app(firebase_admin.get_app(APP_NAME))

    drop()
    yield
    drop()


def _settings(**overrides: Any) -> Any:
    return make_settings(firebase_project_id="demo-test", admin_allowed_uids=ADMIN_UID, **overrides)


def _call(monkeypatch: pytest.MonkeyPatch, outcome: Any, headers: dict[str, str] | None = None) -> Any:
    def verify_id_token(token: str, **_: Any) -> dict[str, Any]:
        assert token == TOKEN
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(auth, "verify_id_token", verify_id_token)
    monkeypatch.setattr(security, "get_firebase_app", lambda settings: object())
    with build_client(_settings()) as c:  # sem override: FirebaseTokenVerifier real
        return c.get(URL, headers={"Authorization": f"Bearer {TOKEN}"} if headers is None else headers)


CASES: list[tuple[str, Callable[[], Any], int]] = [
    ("token válido", lambda: {"uid": ADMIN_UID}, 200),
    ("UID sem autorização", lambda: {"uid": "outro-uid"}, 403),
    ("InvalidIdTokenError", lambda: auth.InvalidIdTokenError(DETAIL), 401),
    ("ExpiredIdTokenError", lambda: auth.ExpiredIdTokenError(DETAIL, cause=None), 401),
    ("RevokedIdTokenError", lambda: auth.RevokedIdTokenError(DETAIL), 401),
    ("UserDisabledError", lambda: auth.UserDisabledError(DETAIL), 401),
    ("UserNotFoundError", lambda: auth.UserNotFoundError(DETAIL), 401),
    ("projeto incompatível (aud)", lambda: auth.InvalidIdTokenError(f'incorrect "aud" claim {DETAIL}'), 401),
    ("ValueError (token malformado)", lambda: ValueError(DETAIL), 401),
    ("CertificateFetchError", lambda: auth.CertificateFetchError(DETAIL, cause=None), 503),
    ("UnavailableError", lambda: fb.UnavailableError(DETAIL), 503),
    ("DeadlineExceededError", lambda: fb.DeadlineExceededError(DETAIL), 503),
    ("UnknownError", lambda: fb.UnknownError(DETAIL), 503),
    ("InternalError", lambda: fb.InternalError(DETAIL), 503),
    ("UnauthenticatedError (credencial admin)", lambda: fb.UnauthenticatedError(DETAIL), 503),
    ("PermissionDeniedError (credencial admin)", lambda: fb.PermissionDeniedError(DETAIL), 503),
    ("DefaultCredentialsError (ADC indisponível)", lambda: google_auth.DefaultCredentialsError(DETAIL), 503),
    ("RefreshError", lambda: google_auth.RefreshError(DETAIL), 503),
    ("MalformedError (é ValueError)", lambda: google_auth.MalformedError(DETAIL), 503),
    ("TransportError", lambda: google_auth.TransportError(DETAIL), 503),
    ("InvalidArgumentError não classificado", lambda: fb.InvalidArgumentError(DETAIL), 500),
    ("RuntimeError inesperado", lambda: RuntimeError(DETAIL), 500),
]


@pytest.mark.parametrize(("name", "outcome", "expected"), CASES, ids=[c[0] for c in CASES])
def test_firebase_outcome_maps_to_status(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], name: str, outcome: Callable[[], Any], expected: int
) -> None:
    r = _call(monkeypatch, outcome())
    logs = capsys.readouterr().err  # o logger "app" grava JSON no stderr (não propaga para o caplog)
    assert r.status_code == expected, name
    if expected != 200:
        assert set(r.json()) == {"error"}  # nenhum dado administrativo
    assert TOKEN not in r.text and DETAIL not in r.text
    assert TOKEN not in logs
    if expected in (401, 503):
        # Mensagens do SDK podem conter partes do token: só o tipo do erro é registrado.
        assert DETAIL not in logs
        assert type(outcome()).__name__ in logs  # diagnóstico: o tipo do erro fica registrado
    if expected == 503:
        assert '"level": "ERROR"' in logs


def test_missing_token_is_401_without_calling_firebase(monkeypatch: pytest.MonkeyPatch) -> None:
    r = _call(monkeypatch, AssertionError("não deveria verificar"), headers={})
    assert r.status_code == 401


def test_admin_write_is_blocked_when_firebase_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def verify_id_token(token: str, **_: Any) -> dict[str, Any]:
        raise fb.UnavailableError(DETAIL)

    monkeypatch.setattr(auth, "verify_id_token", verify_id_token)
    monkeypatch.setattr(security, "get_firebase_app", lambda settings: object())
    with build_client(_settings()) as c:
        r = c.post("/api/v1/admin/categories", json={"name": "Aves"}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 503
    # Nenhuma categoria foi criada (o repositório em memória do app ficou vazio).
    assert c.app.state.repositories.categories.list() == []  # type: ignore[attr-defined]


# --------------------------------------------------------------------- inicialização do SDK (sem mocks de rede)


def _real_call(settings: Any) -> Any:
    with build_client(settings) as c:
        return c.get(URL, headers={"Authorization": f"Bearer {TOKEN}"})


@pytest.mark.parametrize(
    "raw",
    [
        "{não é json",
        '"C:/caminho/para/arquivo.json"',  # string JSON: Certificate() a trataria como caminho
        "[1, 2]",
        '{"type": "authorized_user"}',
        '{"type": "service_account", "project_id": "p", "client_email": "a@b.c", "private_key": "SEGREDO"}',
    ],
    ids=["json inválido", "string json", "lista", "tipo errado", "chave privada inválida"],
)
def test_invalid_service_account_json_is_503(capsys: pytest.CaptureFixture[str], raw: str) -> None:
    r = _real_call(_settings(firebase_service_account_json=raw))
    logs = capsys.readouterr().err
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "auth_unavailable"
    assert "Falha ao inicializar o Firebase Admin SDK" in logs
    assert "SEGREDO" not in logs and "SEGREDO" not in r.text
    assert "caminho" not in logs
    with pytest.raises(ValueError):
        firebase_admin.get_app(APP_NAME)  # nada ficou inicializado pela metade


def test_service_account_string_is_never_opened_as_file(monkeypatch: pytest.MonkeyPatch) -> None:
    from firebase_admin import credentials

    def fail(*_: Any) -> None:
        raise AssertionError("Certificate não deve receber uma string")

    monkeypatch.setattr(credentials, "Certificate", fail)
    with pytest.raises(FirebaseInitFailed):
        get_firebase_app(_settings(firebase_service_account_json='"/etc/passwd"'))


def test_initialization_error_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: Any, **__: Any) -> None:
        raise ValueError(DETAIL)

    monkeypatch.setattr(firebase_admin, "initialize_app", broken)
    r = _real_call(_settings())
    assert r.status_code == 503 and DETAIL not in r.text


def test_sdk_is_initialized_once_under_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []
    real_initialize = firebase_admin.initialize_app

    def counting(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return real_initialize(*args, **kwargs)

    monkeypatch.setattr(firebase_admin, "initialize_app", counting)
    settings = _settings()  # sem JSON: Application Default Credentials, carregadas só sob demanda (sem rede aqui)
    start = threading.Barrier(8)

    def get(_: int) -> Any:
        start.wait()
        return get_firebase_app(settings)

    with ThreadPoolExecutor(max_workers=8) as pool:
        apps = list(pool.map(get, range(8)))
    assert len(calls) == 1
    assert all(a is apps[0] for a in apps)


# --------------------------------------------------------------------- validação antecipada (ambientes implantados)

DEPLOYED = {
    "app_env": "production",
    "data_backend": "firestore",
    "firebase_project_id": "demo",
    "cors_origins": "https://loja.example",
}
VALID_SA = '{"type": "service_account", "project_id": "demo", "client_email": "a@b.c", "private_key": "SEGREDO"}'


@pytest.mark.parametrize("raw", ["{não é json", '"texto"', '{"type": "service_account"}', '{"private_key": "SEGREDO"}'])
def test_deployed_environment_rejects_malformed_service_account(raw: str) -> None:
    with pytest.raises(ValidationError) as exc:
        make_settings(**DEPLOYED, firebase_service_account_json=raw)
    assert "FIREBASE_SERVICE_ACCOUNT_JSON" in str(exc.value)
    assert "SEGREDO" not in str(exc.value)


def test_deployed_environment_accepts_well_formed_service_account() -> None:
    assert make_settings(**DEPLOYED, firebase_service_account_json=VALID_SA).firebase_service_account_json is not None
    assert make_settings(**DEPLOYED).firebase_service_account_json is None  # ADC continua permitido


def test_local_environment_does_not_fail_at_startup() -> None:
    # Fora de staging/produção o erro aparece na primeira verificação (503), sem impedir o desenvolvimento.
    assert make_settings(firebase_service_account_json="{não é json").firebase_service_account_json is not None
