from typing import Any

import pytest
from firebase_admin import auth as real_auth

from app.api.dependencies import get_token_verifier
from app.core import security
from app.core.config import Settings
from app.core.errors import ServiceUnavailable
from app.core.firebase import FirebaseNotConfigured, get_firebase_app
from app.core.security import FirebaseTokenVerifier, InvalidToken
from app.main import create_app
from tests.conftest import ADMIN, USER, build_client, default_verifier, make_settings


def _admin_routes() -> list[tuple[str, str]]:
    # Enumera pelo OpenAPI: qualquer rota administrativa nova entra automaticamente nestes testes.
    spec = create_app(make_settings()).openapi()
    routes = []
    for path, operations in spec["paths"].items():
        if path.startswith("/api/v1/admin"):
            concrete = path.replace("{product_id}", "p1").replace("{category_id}", "c1").replace("{sale_id}", "s1")
            routes.extend((method.upper(), concrete) for method in operations)
    return sorted(routes)


ADMIN_ROUTES = _admin_routes()


def test_admin_routes_match_the_planned_contract() -> None:
    assert (
        sorted(
            [
                ("GET", "/api/v1/admin/me"),
                ("GET", "/api/v1/admin/products"),
                ("POST", "/api/v1/admin/products"),
                ("PATCH", "/api/v1/admin/products/p1"),
                ("GET", "/api/v1/admin/categories"),
                ("POST", "/api/v1/admin/categories"),
                ("PATCH", "/api/v1/admin/categories/c1"),
                ("GET", "/api/v1/admin/stock/movements"),
                ("POST", "/api/v1/admin/stock/movements"),
                ("GET", "/api/v1/admin/sales"),
                ("POST", "/api/v1/admin/sales"),
                ("POST", "/api/v1/admin/sales/s1/cancel"),
                ("GET", "/api/v1/admin/dashboard"),
                ("GET", "/api/v1/admin/settings"),
                ("PUT", "/api/v1/admin/settings"),
            ]
        )
        == ADMIN_ROUTES
    )


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_every_admin_route_requires_token(method: str, path: str) -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.request(method, path, json={})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_every_admin_route_rejects_non_admin(method: str, path: str) -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.request(method, path, json={}, headers=USER)
    assert r.status_code == 403


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_every_admin_route_fails_closed_without_firebase(method: str, path: str) -> None:
    # Sem override: a verificação real seria usada, mas o Firebase não está configurado.
    with build_client(make_settings(admin_allowed_uids="admin-uid-1")) as c:
        r = c.request(method, path, json={}, headers=ADMIN)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "service_unavailable"


def test_invalid_token_is_rejected() -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get("/api/v1/admin/products", headers={"Authorization": "Bearer forjado"})
    assert r.status_code == 401
    assert "Sessão inválida" in r.json()["error"]["message"]


@pytest.mark.parametrize("header", ["Basic dXNlcjpwYXNz", "Bearer", "token-admin", ""])
def test_malformed_authorization_header(header: str) -> None:
    with build_client(verifier=default_verifier()) as c:
        r = c.get("/api/v1/admin/products", headers={"Authorization": header})
    assert r.status_code == 401


def test_valid_admin_is_authorized() -> None:
    verifier = default_verifier()
    with build_client(verifier=verifier) as c:
        r = c.get("/api/v1/admin/products", headers=ADMIN)
    assert r.status_code == 200
    assert verifier.calls == ["token-admin"]


def test_browser_supplied_role_claims_and_headers_are_ignored() -> None:
    # token-user tem claims {"admin": true, "role": "admin"}, mas o UID não está na allowlist.
    with build_client(verifier=default_verifier()) as c:
        r = c.get("/api/v1/admin/products", headers=USER | {"X-Role": "admin", "X-Admin": "true"})
    assert r.status_code == 403


def test_empty_allowlist_denies_everyone() -> None:
    with build_client(make_settings(firebase_project_id="demo"), verifier=default_verifier()) as c:
        r = c.get("/api/v1/admin/products", headers=ADMIN)
    assert r.status_code == 403


def test_local_environment_has_no_auth_bypass() -> None:
    with build_client(make_settings(app_env="local")) as c:
        assert c.get("/api/v1/admin/products").status_code == 401
        assert c.get("/api/v1/admin/products", headers=ADMIN).status_code == 503


def test_auth_is_checked_before_data_availability() -> None:
    # Com Firestore ainda não implementado, rotas de dados respondem 501 — mas só depois da autenticação.
    settings = make_settings(data_backend="firestore", firebase_project_id="demo", admin_allowed_uids="admin-uid-1")
    with build_client(settings, verifier=default_verifier()) as c:
        assert c.get("/api/v1/admin/products").status_code == 401
        assert c.get("/api/v1/admin/products", headers=USER).status_code == 403
        r = c.get("/api/v1/admin/products", headers=ADMIN)
        assert r.status_code == 501
        assert c.get("/api/v1/public/catalog").status_code == 501


def test_default_verifier_dependency_is_none_without_firebase() -> None:
    assert get_token_verifier(make_settings()) is None
    assert isinstance(get_token_verifier(make_settings(firebase_project_id="demo")), FirebaseTokenVerifier)


def test_firebase_app_requires_project_id() -> None:
    with pytest.raises(FirebaseNotConfigured):
        get_firebase_app(make_settings())


# --------------------------------------------------------------------- tradução de erros do Firebase


class _FakeAuth:
    """Imita `firebase_admin.auth` sem rede. As classes de erro são as reais do SDK."""

    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.kwargs: dict[str, Any] = {}

    def __getattr__(self, name: str) -> Any:
        # Classes de erro e demais atributos vêm do módulo real.
        return getattr(real_auth, name)

    def verify_id_token(self, token: str, **kwargs: Any) -> dict[str, Any]:
        self.kwargs = kwargs
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def _verify_with(monkeypatch: pytest.MonkeyPatch, outcome: Any) -> tuple[Any, _FakeAuth]:
    import firebase_admin

    fake = _FakeAuth(outcome)
    monkeypatch.setattr(firebase_admin, "auth", fake)
    monkeypatch.setattr(security, "get_firebase_app", lambda settings: object())
    settings: Settings = make_settings(firebase_project_id="demo")
    return FirebaseTokenVerifier(settings).verify("abc"), fake


def test_firebase_verifier_returns_uid_and_checks_revocation(monkeypatch: pytest.MonkeyPatch) -> None:
    token, fake = _verify_with(monkeypatch, {"uid": "u1", "email": "a@b.c"})
    assert token.uid == "u1"
    assert fake.kwargs["check_revoked"] is True


@pytest.mark.parametrize("name", ["InvalidIdTokenError", "ExpiredIdTokenError", "RevokedIdTokenError", "UserDisabledError"])
def test_firebase_verifier_maps_rejections_to_invalid_token(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    from firebase_admin import auth

    cls = getattr(auth, name)
    error = cls("detalhe") if name in ("RevokedIdTokenError", "UserDisabledError") else cls("detalhe", cause=None)
    with pytest.raises(InvalidToken):
        _verify_with(monkeypatch, error)


def test_firebase_verifier_maps_malformed_token(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(InvalidToken):
        _verify_with(monkeypatch, ValueError("token malformado"))


def test_firebase_verifier_certificate_failure_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    from firebase_admin import auth

    with pytest.raises(ServiceUnavailable):
        _verify_with(monkeypatch, auth.CertificateFetchError("sem rede", cause=None))
