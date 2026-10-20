"""API pública (sem autenticação): somente o que a vitrine precisa.

Nunca expõe vendas, movimentações, estoque mínimo, produtos ocultos/arquivados,
categorias inativas, configurações internas ou identificadores de administradores.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.dependencies import get_public_catalog
from app.schemas.catalog import PublicCategory, PublicProduct
from app.schemas.store import PublicCatalog, PublicStore
from app.services.catalog import PublicCatalogService

router = APIRouter(prefix="/public", tags=["Público"])

CatalogDep = Annotated[PublicCatalogService, Depends(get_public_catalog)]


@router.get("/catalog", summary="Catálogo completo da vitrine")
def get_catalog(catalog: CatalogDep) -> PublicCatalog:
    settings = catalog.store()
    categories = catalog.categories()
    return PublicCatalog(
        store=PublicStore.from_domain(settings),
        categories=[PublicCategory.model_validate(c) for c in categories],
        products=[PublicProduct.from_domain(p) for p in catalog.products(settings, categories)],
    )


@router.get("/products/{product_id}", summary="Produto visível no catálogo")
def get_product(product_id: str, catalog: CatalogDep) -> PublicProduct:
    return PublicProduct.from_domain(catalog.product(product_id))


@router.get("/categories", summary="Categorias ativas")
def list_categories(catalog: CatalogDep) -> list[PublicCategory]:
    return [PublicCategory.model_validate(c) for c in catalog.categories()]


@router.get("/store", summary="Informações comerciais da loja")
def get_store(catalog: CatalogDep) -> PublicStore:
    return PublicStore.from_domain(catalog.store())
