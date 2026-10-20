"""Erros da API em formato único:

    {"error": {"code": "...", "message": "...", "fieldErrors": {"campo": "mensagem"}}}

`fieldErrors` só aparece quando o erro se refere a campos específicos (mesmo formato do
`FieldErrors` do frontend). Detalhes internos nunca são enviados ao cliente.
"""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

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


async def _unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Erro inesperado em %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(error_body("internal_error", "Erro interno. Tente novamente em instantes."), 500)


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unexpected_error)
