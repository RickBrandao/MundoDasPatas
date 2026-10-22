"""GET /api/v1/admin/me: confirmação da autorização administrativa usada pelo frontend."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth as real_auth

from app.api.dependencies import get_repositories, get_token_verifier, require_admin
from app.core import security
from app.core.errors import ServiceUnavailable
from app.core.security import AdminPrincipal, VerifiedToken
from app.main import create_app
from tests.conftest import (
    ADMIN,
    ADMIN_UID,
    USER,
    FakeVerifier,
    build_client,
    default_verifier,
    make_settings,
    unreachable_firestore_repos,
)

ME = "/api/v1/admin/me"


def test_authorized_admin_receives_only_the_verified_uid() -> None:
    verifier = FakeVerifier(
        {"token-admin": VerifiedToken(uid=ADMIN_UID, claims={"uid": ADMIN_UID, "email": "dono@exemplo.com", "name": "Dono"})}
    )
    with build_client(verifier=verifier) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 200
    assert r.json() == {"uid": ADMIN_UID}
    # A dependência do roteador e a da rota são a mesma: o token é verificado uma única vez.
    assert verifier.calls == ["token-admin"]


def test_response_is_never_cached() -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.headers["cache-control"] == "no-store"


def test_missing_token_is_401() -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get(ME)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("header", ["Bearer forjado", "Basic dXNlcjpwYXNz", "Bearer", "token-admin"])
def test_invalid_token_is_401(header: str) -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get(ME, headers={"Authorization": header})
    assert r.status_code == 401


def test_authenticated_user_outside_allowlist_is_403() -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get(ME, headers=USER)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden"


def test_uid_supplied_by_the_browser_is_ignored() -> None:
    with build_client(verifier=default_verifier()) as c:
        denied = c.get(ME, params={"uid": ADMIN_UID}, headers=USER | {"X-Uid": ADMIN_UID, "X-Role": "admin"})
        allowed = c.get(ME, params={"uid": "outro-uid"}, headers=ADMIN | {"X-Uid": "outro-uid"})
    assert denied.status_code == 403
    assert allowed.json() == {"uid": ADMIN_UID}


def test_firebase_not_configured_is_503() -> None:
    # Sem override: seria usada a verificação real, mas não há FIREBASE_PROJECT_ID.
    with build_client(make_settings(admin_allowed_uids=ADMIN_UID)) as c:
        assert c.get(ME).status_code == 401
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "service_unavailable"


def test_verifier_operational_failure_is_503() -> None:
    class DownVerifier:
        def verify(self, id_token: str) -> VerifiedToken:
            raise ServiceUnavailable("Autenticação indisponível no momento.")

    with build_client(verifier=DownVerifier()) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 503


# --------------------------------------------------------------------- verificador real (SDK simulado)


def _client_with_sdk_outcome(monkeypatch: pytest.MonkeyPatch, outcome: Any) -> Any:
    """Usa o `FirebaseTokenVerifier` real; só `firebase_admin.auth.verify_id_token` é simulado (sem rede)."""
    import firebase_admin

    class FakeAuth:
        def __getattr__(self, name: str) -> Any:
            return getattr(real_auth, name)

        def verify_id_token(self, token: str, **kwargs: Any) -> dict[str, Any]:
            assert kwargs["check_revoked"] is True
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr(firebase_admin, "auth", FakeAuth())
    monkeypatch.setattr(security, "get_firebase_app", lambda settings: object())
    return build_client(make_settings(firebase_project_id="demo", admin_allowed_uids=ADMIN_UID))


def test_real_verifier_accepts_allowed_uid(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client_with_sdk_outcome(monkeypatch, {"uid": ADMIN_UID}) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 200
    assert r.json() == {"uid": ADMIN_UID}


def test_revoked_token_is_401(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client_with_sdk_outcome(monkeypatch, real_auth.RevokedIdTokenError("revogado")) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 401
    assert "Sessão inválida" in r.json()["error"]["message"]


def test_expired_token_is_401(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client_with_sdk_outcome(monkeypatch, real_auth.ExpiredIdTokenError("expirado", cause=None)) as c:
        assert c.get(ME, headers=ADMIN).status_code == 401


def test_disabled_user_is_401(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client_with_sdk_outcome(monkeypatch, real_auth.UserDisabledError("desativado")) as c:
        assert c.get(ME, headers=ADMIN).status_code == 401


def test_firebase_unreachable_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client_with_sdk_outcome(monkeypatch, real_auth.CertificateFetchError("sem rede", cause=None)) as c:
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 503


# --------------------------------------------------------------------- independência e herança


def test_does_not_depend_on_repositories() -> None:
    # Firestore inacessível: rotas de dados respondem 503, mas /me continua funcionando.
    settings = make_settings(data_backend="firestore", firebase_project_id="demo", admin_allowed_uids=ADMIN_UID)
    with build_client(settings, unreachable_firestore_repos(settings), verifier=default_verifier()) as c:
        assert c.get("/api/v1/admin/products", headers=ADMIN).status_code == 503
        r = c.get(ME, headers=ADMIN)
    assert r.status_code == 200


def test_does_not_touch_repositories_even_when_they_fail() -> None:
    def broken_repositories() -> None:
        raise AssertionError("/admin/me não deve acessar repositórios")

    app = create_app(make_settings(firebase_project_id="demo", admin_allowed_uids=ADMIN_UID))
    app.dependency_overrides[get_repositories] = broken_repositories
    app.dependency_overrides[get_token_verifier] = default_verifier
    with TestClient(app, raise_server_exceptions=True) as c:
        assert c.get(ME, headers=ADMIN).status_code == 200


def test_inherits_router_security_dependency() -> None:
    # O principal da rota vem de `require_admin` (a mesma dependência aplicada ao roteador administrativo):
    # substituí-la muda a resposta; não existe outro caminho de verificação nesta rota.
    app = create_app(make_settings())
    app.dependency_overrides[require_admin] = lambda: AdminPrincipal(uid="principal-da-dependencia")
    with TestClient(app) as c:
        r = c.get(ME)
    assert r.json() == {"uid": "principal-da-dependencia"}


def test_cors_preflight_allows_authorization_only_for_configured_origin() -> None:
    settings = make_settings(firebase_project_id="demo", admin_allowed_uids=ADMIN_UID, cors_origins="http://localhost:5173")
    preflight = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    with build_client(settings, verifier=default_verifier()) as c:
        ok = c.options(ME, headers=preflight | {"Origin": "http://localhost:5173"})
        other = c.options(ME, headers=preflight | {"Origin": "https://malicioso.example"})
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in other.headers
