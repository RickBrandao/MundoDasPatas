from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.api.dependencies import AdminDep, get_category_service, get_product_service
from app.schemas.catalog import CategoryCreate, CategoryOut, CategoryUpdate, ProductAdminOut, ProductCreate, ProductUpdate
from app.services.catalog import CategoryService, ProductService

router = APIRouter()

ProductsDep = Annotated[ProductService, Depends(get_product_service)]
CategoriesDep = Annotated[CategoryService, Depends(get_category_service)]


@router.get("/products", tags=["Admin · Produtos"], summary="Todos os produtos (inclui ocultos e arquivados)")
def list_products(products: ProductsDep) -> list[ProductAdminOut]:
    return [ProductAdminOut.from_domain(p) for p in products.list()]


@router.post("/products", tags=["Admin · Produtos"], status_code=status.HTTP_201_CREATED, summary="Cadastrar produto")
def create_product(data: ProductCreate, admin: AdminDep, products: ProductsDep) -> ProductAdminOut:
    return ProductAdminOut.from_domain(products.create(data, admin.uid))


@router.patch(
    "/products/{product_id}",
    tags=["Admin · Produtos"],
    summary="Editar, publicar/ocultar ou arquivar produto (estoque muda só por movimentações)",
)
def update_product(product_id: str, data: ProductUpdate, products: ProductsDep) -> ProductAdminOut:
    return ProductAdminOut.from_domain(products.update(product_id, data))


@router.get("/categories", tags=["Admin · Categorias"], summary="Todas as categorias")
def list_categories(categories: CategoriesDep) -> list[CategoryOut]:
    return [CategoryOut.model_validate(c) for c in categories.list()]


@router.post("/categories", tags=["Admin · Categorias"], status_code=status.HTTP_201_CREATED, summary="Criar categoria")
def create_category(data: CategoryCreate, categories: CategoriesDep) -> CategoryOut:
    return CategoryOut.model_validate(categories.create(data))


@router.patch("/categories/{category_id}", tags=["Admin · Categorias"], summary="Renomear, ativar ou desativar categoria")
def update_category(category_id: str, data: CategoryUpdate, categories: CategoriesDep) -> CategoryOut:
    return CategoryOut.model_validate(categories.update(category_id, data))
