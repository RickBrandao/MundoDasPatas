from fastapi import FastAPI

from app.main import create_app
from tests.conftest import build_client, make_settings


def test_app_starts_without_firebase_credentials() -> None:
    app = create_app(make_settings())
    assert isinstance(app, FastAPI)


def test_module_level_app_imports() -> None:
    from app.main import app

    assert app.title == "Mundo das Patas API"


def test_health_reports_process_and_dependencies_without_claiming_firestore() -> None:
    with build_client(make_settings()) as c:
        r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["environment"] == "test"
    assert body["dependencies"]["auth"]["status"] == "not_configured"
    assert body["dependencies"]["database"]["status"] == "ephemeral"


def test_health_with_firestore_backend_reports_configuration_without_connecting() -> None:
    # Sem repositórios injetados: create_app monta os repositórios reais, mas não abre conexão.
    with build_client(make_settings(data_backend="firestore", firebase_project_id="demo")) as c:
        body = c.get("/health").json()
    # "configured" descreve a configuração; o health check não afirma conexão verificada.
    assert body["dependencies"]["database"]["status"] == "configured"
    assert body["dependencies"]["auth"]["status"] == "configured"
    assert "demo" not in str(body)  # não expõe o ID do projeto


def test_health_firestore_without_project_and_with_emulator() -> None:
    with build_client(make_settings(data_backend="firestore")) as c:
        assert c.get("/health").json()["dependencies"]["database"]["status"] == "not_configured"
    settings = make_settings(data_backend="firestore", firebase_project_id="demo-x", firestore_emulator_host="127.0.0.1:8181")
    with build_client(settings) as c:
        assert c.get("/health").json()["dependencies"]["database"]["status"] == "emulator"


def test_docs_available_outside_production() -> None:
    with build_client(make_settings(app_env="local")) as c:
        assert c.get("/docs").status_code == 200
        assert c.get("/openapi.json").status_code == 200


def test_docs_disabled_in_production() -> None:
    settings = make_settings(
        app_env="production",
        data_backend="firestore",
        firebase_project_id="mdp-prod",
        cors_origins="https://mundodaspatas.com.br",
    )
    with build_client(settings) as c:
        assert c.get("/docs").status_code == 404
        assert c.get("/openapi.json").status_code == 404
        assert c.get("/health").status_code == 200


def test_security_headers() -> None:
    with build_client(make_settings()) as c:
        public = c.get("/api/v1/public/store")
        admin = c.get("/api/v1/admin/products")
    assert public.headers["x-content-type-options"] == "nosniff"
    assert admin.headers["cache-control"] == "no-store"


def test_cors_only_for_configured_origins() -> None:
    settings = make_settings(cors_origins="http://localhost:5173")
    with build_client(settings) as c:
        allowed = c.options(
            "/api/v1/public/catalog",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
        )
        denied = c.options(
            "/api/v1/public/catalog",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
        )
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in denied.headers
