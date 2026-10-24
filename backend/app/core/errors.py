"""Erros da API em formato único:

    {"error": {"code": "...", "message": "...", "fieldErrors": {"campo": "mensagem"}}}

`fieldErrors` só aparece quando o erro se refere a campos específicos (mesmo formato do
`FieldErrors` do frontend). Detalhes internos nunca são enviados ao cliente.

Erros inesperados (500) também não vão para os logs com detalhes: mensagens de exceção podem
conter tokens, senhas ou dados pessoais. Registra-se só o tipo da exceção (e das causas), o ponto
de origem (módulo:função:linha), o método, o modelo da rota (`/api/v1/admin/products/{product_id}`,
nunca o caminho real nem a query string) e um identificador da ocorrência, devolvido ao cliente
no cabeçalho `X-Error-Id`.

O Starlette relança a exceção ao servidor depois de responder 500 (`ServerErrorMiddleware`), e o
Uvicorn então registra o traceback completo. `UnexpectedErrorGuard` impede isso em duas camadas:
- interna (logo acima das rotas): responde 500 sem relançar; a resposta ainda passa pelos
  middlewares de CORS e de cabeçalhos de segurança;
- externa (por fora do `ServerErrorMiddleware`): cobre falhas nos próprios middlewares e
  descarta a exceção relançada, que assim nunca chega ao servidor ASGI.
"""

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("app.errors")


class ApiError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(
        self,
        message: str | None = None,
        *,
        field_errors: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.message = message or self.message
        self.field_errors = field_errors
        self.headers = headers
        super().__init__(self.message)


class Unauthorized(ApiError):
    status_code = 401
    code = "unauthorized"
    message = "Autenticação necessária."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message, headers={"WWW-Authenticate": "Bearer"})


class Forbidden(ApiError):
    status_code = 403
    code = "forbidden"
    message = "Você não tem permissão para esta operação."


class NotFound(ApiError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class Conflict(ApiError):
    status_code = 409
    code = "conflict"
    message = "A operação conflita com o estado atual."


class InsufficientStock(Conflict):
    code = "insufficient_stock"
    message = "Estoque insuficiente."


class PayloadTooLarge(ApiError):
    status_code = 413
    code = "payload_too_large"
    message = "Arquivo grande demais para envio."


class UnsupportedMediaType(ApiError):
    status_code = 415
    code = "unsupported_media_type"
    message = "Formato não suportado. Use JPEG, PNG ou WebP."


class ValidationFailed(ApiError):
    """Regra de negócio violada em campos da requisição (ex.: categoria inexistente)."""

    status_code = 422
    code = "validation_error"
    message = "Revise os campos destacados."


class NotImplementedYet(ApiError):
    status_code = 501
    code = "not_implemented"
    message = "Funcionalidade ainda não disponível nesta versão da API."


class ServiceUnavailable(ApiError):
    status_code = 503
    code = "service_unavailable"
    message = "Serviço temporariamente indisponível."


def error_body(code: str, message: str, field_errors: dict[str, str] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if field_errors:
        error["fieldErrors"] = field_errors
    return {"error": error}


def _field_name(loc: tuple[Any, ...]) -> str:
    # ("body", "items", 0, "qty") → "items.0.qty"; a origem (body/query/path/header) é omitida.
    parts = [str(p) for p in loc[1:]] if len(loc) > 1 else [str(p) for p in loc]
    return ".".join(parts) or "body"


async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(error_body(exc.code, exc.message, exc.field_errors), exc.status_code, headers=exc.headers)


async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields: dict[str, str] = {}
    for err in exc.errors():
        fields.setdefault(_field_name(tuple(err.get("loc", ()))), str(err.get("msg", "Valor inválido.")))
    return JSONResponse(error_body("validation_error", "Revise os campos destacados.", fields), 422)


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
}


async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = _HTTP_CODES.get(exc.status_code, "http_error")
    message = "Recurso não encontrado." if exc.status_code == 404 else str(exc.detail)
    return JSONResponse(error_body(code, message), exc.status_code, headers=getattr(exc, "headers", None))


# ----------------------------------------------------------------- erros inesperados (500)

_ERROR_ID_KEY = "app.error_id"  # no scope ASGI: a ocorrência já foi registrada (evita log duplicado)


def _type_name(exc: BaseException) -> str:
    cls = type(exc)
    return cls.__qualname__ if cls.__module__ == "builtins" else f"{cls.__module__}.{cls.__qualname__}"


def _causes(exc: BaseException) -> list[str]:
    # Só os tipos da cadeia (`raise ... from ...` e contexto implícito): as mensagens podem ser sensíveis.
    names: list[str] = []
    seen = {id(exc)}
    current = exc.__cause__ or exc.__context__
    while current is not None and id(current) not in seen and len(names) < 5:
        seen.add(id(current))
        names.append(_type_name(current))
        current = current.__cause__ or current.__context__
    return names


def _origin(exc: BaseException) -> str:
    # Onde a exceção foi lançada (módulo:função:linha): localiza a falha sem expor valores.
    tb = exc.__traceback__
    if tb is None:
        return "?"
    while tb.tb_next is not None:
        tb = tb.tb_next
    return f"{tb.tb_frame.f_globals.get('__name__', '?')}:{tb.tb_frame.f_code.co_name}:{tb.tb_lineno}"


def _log_unexpected(scope: Scope, exc: BaseException) -> str:
    """Registra a ocorrência só com metadados controlados e devolve o seu identificador."""
    error_id = scope.get(_ERROR_ID_KEY)
    if error_id is None:
        error_id = scope[_ERROR_ID_KEY] = uuid.uuid4().hex
        logger.error(
            "Erro inesperado: id=%s tipo=%s causas=%s origem=%s metodo=%s rota=%s",
            error_id,
            _type_name(exc),
            ",".join(_causes(exc)) or "-",
            _origin(exc),
            scope.get("method", "?"),
            getattr(scope.get("route"), "path", None) or "(não identificada)",
        )
    return error_id


def _internal_error_response(error_id: str) -> JSONResponse:
    body = error_body("internal_error", "Erro interno. Tente novamente em instantes.")
    return JSONResponse(body, 500, headers={"X-Error-Id": error_id})


async def _unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    # Handler do ServerErrorMiddleware: só é alcançado por falhas nos próprios middlewares.
    return _internal_error_response(_log_unexpected(request.scope, exc))


class UnexpectedErrorGuard:
    """Middleware ASGI: converte exceções não tratadas em 500 genérico sem relançá-las ao servidor."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def _send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception as exc:
            error_id = _log_unexpected(scope, exc)
            # Com a resposta já iniciada (streaming) não há como enviar o 500: a conexão só é encerrada.
            if not response_started:
                await _internal_error_response(error_id)(scope, receive, send)


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unexpected_error)
    # Primeiro middleware adicionado = o mais interno: o 500 ainda recebe CORS e cabeçalhos de segurança.
    app.add_middleware(UnexpectedErrorGuard)
    # Camada externa: envolve a pilha inteira, inclusive o ServerErrorMiddleware que relança a exceção.
    build_stack = app.build_middleware_stack
    app.build_middleware_stack = lambda: UnexpectedErrorGuard(build_stack())  # type: ignore[method-assign]
