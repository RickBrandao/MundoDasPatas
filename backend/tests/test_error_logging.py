"""Erros inesperados não vazam dados sensíveis: nem na resposta, nem nos logs da aplicação, nem no servidor ASGI.

Os marcadores abaixo são fictícios; qualquer ocorrência deles na saída indica vazamento.
"""

import asyncio
import logging
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.errors import Conflict, Forbidden, NotFound, NotImplementedYet, ServiceUnavailable, ValidationFailed
from app.main import create_app
from tests.conftest import ADMIN, build_client, default_verifier, make_settings

TOKEN = "TOKEN_TESTE_NAO_REAL_123"
PASSWORD = "SENHA_FICTICIA_NAO_REAL_789"
CAUSE = "CAUSA_SENSIVEL_NAO_REAL_456"
MARKERS = (TOKEN, PASSWORD, CAUSE)
GENERIC_500 = {"error": {"code": "internal_error", "message": "Erro interno. Tente novamente em instantes."}}
BACKEND_DIR = Path(__file__).resolve().parents[1]


def _raise_token() -> None:
    raise RuntimeError(f"falha ao chamar serviço com Authorization: Bearer {TOKEN}")


def _raise_password() -> None:
    raise ConnectionError(f"postgresql://admin:{PASSWORD}@db.interno:5432/loja")


def _raise_chained() -> None:
    try:
        raise KeyError(CAUSE)
    except KeyError as exc:
        raise ValueError(f"envolvendo {TOKEN}") from exc


def _raise_implicit_context() -> None:
    try:
        raise LookupError(CAUSE)
    except LookupError:
        raise TypeError(PASSWORD)  # noqa: B904 — contexto implícito também precisa ser protegido


ROUTES = {
    "token": _raise_token,
    "senha": _raise_password,
    "encadeada": _raise_chained,
    "contexto": _raise_implicit_context,
}


def _app(**settings: Any) -> FastAPI:
    app = create_app(make_settings(**settings))
    for name, handler in ROUTES.items():
        app.add_api_route(f"/boom/{name}/{{item_id}}", handler, methods=["GET", "POST"])
    app.add_api_route("/api/v1/admin/boom-teste", _raise_token, methods=["GET"])
    return app


def _get(client: TestClient, name: str) -> Any:
    # O marcador também vai no cabeçalho, no caminho, na query string e no corpo: nada disso pode ser registrado.
    return client.post(
        f"/boom/{name}/{TOKEN}?senha={PASSWORD}",
        json={"password": PASSWORD},
        headers={"Authorization": f"Bearer {TOKEN}", "Cookie": f"sessao={TOKEN}"},
    )


def _assert_no_markers(text: str) -> None:
    for marker in MARKERS:
        assert marker not in text


# --------------------------------------------------------------------- cenários A, B e C


@pytest.mark.parametrize(
    ("name", "expected_type", "expected_causes"),
    [
        ("token", "RuntimeError", "-"),  # cenário A
        ("senha", "ConnectionError", "-"),  # cenário B
        ("encadeada", "ValueError", "KeyError"),  # cenário C (raise ... from ...)
        ("contexto", "TypeError", "LookupError"),  # cenário C (contexto implícito)
    ],
)
def test_unexpected_error_is_generic_and_logs_only_safe_metadata(
    capsys: pytest.CaptureFixture[str], name: str, expected_type: str, expected_causes: str
) -> None:
    with TestClient(_app()) as client:
        r = _get(client, name)
    logs = capsys.readouterr().err

    assert r.status_code == 500
    assert r.json() == GENERIC_500
    _assert_no_markers(r.text)
    _assert_no_markers(str(r.headers))
    _assert_no_markers(logs)
    assert "Traceback" not in logs

    lines = [line for line in logs.splitlines() if "Erro inesperado" in line]
    assert len(lines) == 1  # uma ocorrência, um registro
    line = lines[0]
    assert '"level": "ERROR"' in line and '"logger": "app.errors"' in line and '"ts": ' in line
    assert f"tipo={expected_type} " in line
    assert f"causas={expected_causes} " in line
    assert "metodo=POST" in line
    assert "rota=/boom/" + name + "/{item_id}" in line  # modelo da rota, nunca o caminho real
    assert f"origem=tests.test_error_logging:{ROUTES[name].__name__}:" in line
    assert f"id={r.headers['x-error-id']} " in line  # correlação entre a resposta e o log


def test_formatter_never_writes_tracebacks(capsys: pytest.CaptureFixture[str]) -> None:
    # Defesa em profundidade: mesmo um `logger.exception` futuro grava só o tipo da exceção.
    create_app(make_settings())
    try:
        raise RuntimeError(TOKEN)
    except RuntimeError:
        logging.getLogger("app.qualquer").exception("falhou")
    logs = capsys.readouterr().err
    _assert_no_markers(logs)
    assert '"exceptionType": "RuntimeError"' in logs and "Traceback" not in logs


# --------------------------------------------------------------------- propagação ao servidor ASGI (cenário D)


def test_exception_does_not_propagate_to_the_asgi_server() -> None:
    # raise_server_exceptions=True: se a exceção chegasse ao servidor, o TestClient a relançaria aqui.
    with TestClient(_app(), raise_server_exceptions=True) as client:
        r = _get(client, "encadeada")
    assert r.status_code == 500 and r.json() == GENERIC_500


def test_raw_asgi_call_completes_without_raising() -> None:
    app = _app()
    sent: list[dict[str, Any]] = []
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": f"/boom/token/{TOKEN}",
        "raw_path": f"/boom/token/{TOKEN}".encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"teste"), (b"authorization", f"Bearer {TOKEN}".encode())],
        "client": ("127.0.0.1", 1),
        "server": ("teste", 80),
    }

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(app(scope, receive, send))  # não pode relançar: é o que o servidor veria
    assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 500
    _assert_no_markers(repr(sent))


def test_failure_inside_a_middleware_is_contained(capsys: pytest.CaptureFixture[str]) -> None:
    # Falha fora das rotas: alcança o ServerErrorMiddleware, que relança — a camada externa contém.
    app = _app()

    @app.middleware("http")
    async def broken(request: Request, call_next: Any) -> Any:
        raise RuntimeError(TOKEN)

    with TestClient(app, raise_server_exceptions=True) as client:
        r = client.get("/health", headers={"Authorization": f"Bearer {TOKEN}"})
    logs = capsys.readouterr().err
    assert r.status_code == 500 and r.json() == GENERIC_500
    _assert_no_markers(logs)
    assert len([line for line in logs.splitlines() if "Erro inesperado" in line]) == 1
    assert f"id={r.headers['x-error-id']} " in logs


_UVICORN_SCRIPT = textwrap.dedent(
    """
    import socket, threading, time, urllib.error, urllib.request
    import uvicorn
    from tests.test_error_logging import _app

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(_app(), host="127.0.0.1", port=port, log_level="debug"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        assert time.monotonic() < deadline, "uvicorn não iniciou"
        time.sleep(0.05)
    for name in ("token", "senha", "encadeada", "contexto"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/boom/{name}/item-1",
            headers={"Authorization": "Bearer TOKEN_TESTE_NAO_REAL_123"},
        )
        try:
            urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as exc:
            print("STATUS", name, exc.code, exc.read().decode(), flush=True)
    server.should_exit = True
    thread.join(timeout=20)
    """
)


def test_uvicorn_does_not_log_a_traceback() -> None:
    # Servidor real, requisições HTTP reais; inspeciona toda a saída do processo (não só o formatter da aplicação).
    result = subprocess.run(  # noqa: S603 — script fixo deste teste, executado pelo próprio interpretador
        [sys.executable, "-c", _UVICORN_SCRIPT],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    for name in ROUTES:
        assert f"STATUS {name} 500 " in output
    _assert_no_markers(output)
    assert "Exception in ASGI application" not in output
    assert "Traceback" not in output
    assert output.count("Erro inesperado") == len(ROUTES)


# --------------------------------------------------------------------- headers e erros conhecidos (cenário E)


def test_unexpected_error_keeps_security_and_cors_headers() -> None:
    app = _app(cors_origins="https://loja.example")
    with TestClient(app) as client:
        r = client.get("/api/v1/admin/boom-teste", headers={"Origin": "https://loja.example"})
    assert r.status_code == 500
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["access-control-allow-origin"] == "https://loja.example"


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (Forbidden(), 403, "forbidden"),
        (NotFound(), 404, "not_found"),
        (Conflict("Estado mudou."), 409, "conflict"),
        (ValidationFailed(field_errors={"categoryId": "Categoria inexistente."}), 422, "validation_error"),
        (NotImplementedYet(), 501, "not_implemented"),
        (ServiceUnavailable(), 503, "service_unavailable"),
    ],
)
def test_known_errors_keep_their_status(capsys: pytest.CaptureFixture[str], error: Exception, status: int, code: str) -> None:
    def fail() -> None:
        raise error

    app = create_app(make_settings())
    app.add_api_route("/falha", fail, methods=["GET"])
    with TestClient(app, raise_server_exceptions=True) as client:
        r = client.get("/falha")
    assert r.status_code == status
    assert r.json()["error"]["code"] == code
    assert "x-error-id" not in r.headers
    assert "Erro inesperado" not in capsys.readouterr().err


def test_http_flows_keep_their_status(capsys: pytest.CaptureFixture[str]) -> None:
    with build_client(verifier=default_verifier()) as c:
        assert c.get("/api/v1/admin/products").status_code == 401  # sem token
        assert c.get("/api/v1/admin/products", headers={"Authorization": "Bearer forjado"}).status_code == 401
        assert c.get("/api/v1/admin/products", headers={"Authorization": "Bearer token-user"}).status_code == 403
        assert c.post("/api/v1/admin/categories", json={}, headers=ADMIN).status_code == 422
        assert c.post("/api/v1/admin/categories", json={"name": "Aves"}, headers=ADMIN).status_code == 201
        assert c.post("/api/v1/admin/categories", json={"name": "AVES"}, headers=ADMIN).status_code == 409
        assert c.get("/nao-existe").status_code == 404
        assert c.post("/api/v1/admin/sales/x/cancel", headers=ADMIN).status_code == 422  # sem Idempotency-Key
    with build_client(make_settings(admin_allowed_uids="admin-uid-1")) as c:
        assert c.get("/api/v1/admin/products", headers=ADMIN).status_code == 503  # Firebase não configurado
    assert "Erro inesperado" not in capsys.readouterr().err
