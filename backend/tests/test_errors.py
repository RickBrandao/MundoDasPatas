from fastapi.testclient import TestClient

from app.core.errors import Conflict, NotImplementedYet
from app.main import create_app
from tests.conftest import make_settings


def _client_with(route_handler: object) -> TestClient:
    app = create_app(make_settings())
    app.add_api_route("/boom", route_handler, methods=["GET"])  # type: ignore[arg-type]
    return TestClient(app, raise_server_exceptions=False)


def test_unexpected_error_returns_generic_500_without_internal_details() -> None:
    def boom() -> None:
        raise RuntimeError("senha=123 conexão interna falhou")

    r = _client_with(boom).get("/boom")
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "internal_error", "message": "Erro interno. Tente novamente em instantes."}}
    assert "senha" not in r.text


def test_api_error_format() -> None:
    def conflict() -> None:
        raise Conflict("Estado mudou.", field_errors={"name": "Duplicado."})

    r = _client_with(conflict).get("/boom")
    assert r.status_code == 409
    assert r.json() == {"error": {"code": "conflict", "message": "Estado mudou.", "fieldErrors": {"name": "Duplicado."}}}


def test_not_implemented_error() -> None:
    def pending() -> None:
        raise NotImplementedYet()

    r = _client_with(pending).get("/boom")
    assert r.status_code == 501
    assert r.json()["error"]["code"] == "not_implemented"


def test_unknown_route_uses_standard_format() -> None:
    r = TestClient(create_app(make_settings())).get("/nao-existe")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Recurso não encontrado."}}


def test_method_not_allowed_uses_standard_format() -> None:
    r = TestClient(create_app(make_settings())).delete("/health")
    assert r.status_code == 405
    assert r.json()["error"]["code"] == "method_not_allowed"
