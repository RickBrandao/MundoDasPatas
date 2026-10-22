"""Aplicação FastAPI do Mundo das Patas.

`create_app()` monta a aplicação a partir da configuração (testes passam a sua própria).
`app` é a instância usada por `uvicorn app.main:app` e, futuramente, pela Vercel.
Nenhuma conexão externa é aberta aqui: Firebase só é inicializado na primeira verificação de token
e o cliente do Firestore, na primeira operação de dados.
"""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1.router import router as api_v1_router
from app.core.config import DataBackend, Settings, get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.repositories.base import Repositories
from app.repositories.memory import create_memory_repositories
from app.schemas.store import DependencyStatus, HealthOut


def build_repositories(settings: Settings) -> Repositories:
    if settings.data_backend is DataBackend.MEMORY:
        return create_memory_repositories()
    # Sem fallback para memória: configuração incompleta ou banco indisponível respondem 503.
    from app.repositories.firestore import create_firestore_repositories

    return create_firestore_repositories(settings)


def create_app(settings: Settings | None = None, repositories: Repositories | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="Mundo das Patas API",
        version=__version__,
        description="API do catálogo público e do painel administrativo do Mundo das Patas.",
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.settings = settings
    app.state.repositories = repositories if repositories is not None else build_repositories(settings)

    register_error_handlers(app)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PATCH", "PUT"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
            expose_headers=["Idempotent-Replayed"],
            # Sem cookies: a autenticação vai no cabeçalho Authorization.
            allow_credentials=False,
            max_age=600,
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.url.path.startswith("/api/v1/admin"):
            # Dados administrativos não podem ficar em cache de navegador ou CDN.
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health", tags=["Sistema"], summary="Saúde do processo e situação das dependências")
    def health() -> HealthOut:
        return HealthOut(status="ok", environment=settings.app_env, version=__version__, dependencies=_dependencies(app))

    app.include_router(api_v1_router)
    return app


def _dependencies(app: FastAPI) -> dict[str, DependencyStatus]:
    settings: Settings = app.state.settings
    auth = (
        DependencyStatus(status="configured", detail="Firebase Authentication configurado (não verificado por este endpoint).")
        if settings.firebase_configured
        else DependencyStatus(status="not_configured", detail="Rotas administrativas recusam acesso (503).")
    )
    if settings.data_backend is DataBackend.MEMORY:
        database = DependencyStatus(status="ephemeral", detail="Repositórios em memória (somente desenvolvimento/testes).")
    elif not settings.firebase_configured:
        database = DependencyStatus(
            status="not_configured", detail="Cloud Firestore sem FIREBASE_PROJECT_ID: rotas de dados respondem 503."
        )
    elif settings.firestore_emulator_host:
        database = DependencyStatus(status="emulator", detail="Firestore Emulator local (somente desenvolvimento).")
    else:
        database = DependencyStatus(status="configured", detail="Cloud Firestore configurado (não verificado por este endpoint).")
    return {"auth": auth, "database": database}


app = create_app()
