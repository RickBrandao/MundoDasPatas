"""Dependências do FastAPI: configuração, autenticação e serviços.

Testes substituem `get_token_verifier` e/ou `get_repositories` via `app.dependency_overrides`.
Não existe variável de ambiente que desligue a autenticação.
"""

from typing import Annotated

from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings
from app.core.security import AdminPrincipal, FirebaseTokenVerifier, TokenVerifier, authenticate_admin
from app.repositories.base import Repositories
from app.services.catalog import CategoryService, ProductService, PublicCatalogService
from app.services.images import ProductImageService
from app.services.inventory import InventoryService
from app.services.store import DashboardService, SettingsService
from app.storage.base import ObjectStore

# auto_error=False: a ausência do token vira o erro padronizado 401 (e não o 403 padrão do FastAPI).
_bearer = HTTPBearer(auto_error=False, description="Firebase ID Token do usuário administrativo.")


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_token_verifier(settings: SettingsDep) -> TokenVerifier | None:
    """None quando o Firebase não está configurado — `require_admin` então recusa com 503."""
    return FirebaseTokenVerifier(settings) if settings.firebase_configured else None


def require_admin(
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    verifier: Annotated[TokenVerifier | None, Depends(get_token_verifier)],
) -> AdminPrincipal:
    # `def` síncrono: a verificação pode acessar a rede e roda no threadpool do FastAPI.
    return authenticate_admin(credentials.credentials if credentials else None, verifier, settings)


AdminDep = Annotated[AdminPrincipal, Depends(require_admin)]

IdempotencyKey = Annotated[
    str,
    Header(
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Identificador único da operação gerado pelo cliente (ex.: UUID). Repetições devolvem o resultado original.",
    ),
]


def get_repositories(request: Request) -> Repositories:
    return request.app.state.repositories


ReposDep = Annotated[Repositories, Depends(get_repositories)]


def get_object_store(request: Request) -> ObjectStore | None:
    return request.app.state.object_store


def get_image_service(repos: ReposDep, store: Annotated[ObjectStore | None, Depends(get_object_store)]) -> ProductImageService:
    return ProductImageService(repos, store)


def get_public_catalog(repos: ReposDep) -> PublicCatalogService:
    return PublicCatalogService(repos)


def get_product_service(repos: ReposDep) -> ProductService:
    return ProductService(repos)


def get_category_service(repos: ReposDep) -> CategoryService:
    return CategoryService(repos)


def get_inventory_service(repos: ReposDep) -> InventoryService:
    return InventoryService(repos)


def get_settings_service(repos: ReposDep) -> SettingsService:
    return SettingsService(repos)


def get_dashboard_service(
    repos: ReposDep, inventory: Annotated[InventoryService, Depends(get_inventory_service)]
) -> DashboardService:
    return DashboardService(repos, inventory)
