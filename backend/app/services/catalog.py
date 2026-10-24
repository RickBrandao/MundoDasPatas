"""Produtos e categorias: catálogo público (somente leitura) e gestão administrativa."""

from dataclasses import replace

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.domain.catalog import active_category_ids, is_product_visible, normalize_text, visible_products
from app.domain.inventory import initial_stock_movement
from app.domain.models import DEFAULT_SETTINGS, Category, Product, StoreSettings
from app.repositories.base import CategoryNameTaken, InventoryTransaction, Repositories
from app.schemas.catalog import CategoryCreate, CategoryUpdate, ProductCreate, ProductUpdate
from app.services.common import Clock, IdFactory, new_id, utc_now

PRICE_REQUIRED = "Informe o preço ou desmarque “Exibir preço no catálogo”."
IMAGE_VIA_UPLOAD = "A foto é definida pelo envio de imagem do produto."


def load_settings(repos: Repositories) -> StoreSettings:
    return repos.settings.get() or DEFAULT_SETTINGS


class PublicCatalogService:
    def __init__(self, repos: Repositories) -> None:
        self._repos = repos

    def store(self) -> StoreSettings:
        return load_settings(self._repos)

    def categories(self) -> list[Category]:
        active = [c for c in self._repos.categories.list() if c.active]
        return sorted(active, key=lambda c: normalize_text(c.name))

    def products(self, settings: StoreSettings, categories: list[Category]) -> list[Product]:
        return visible_products(self._repos.products.list(), categories, settings)

    def product(self, product_id: str) -> Product:
        settings = load_settings(self._repos)
        product = self._repos.products.get(product_id)
        # Produto oculto responde 404, como se não existisse: não revela o que está fora do catálogo.
        if product is None or not is_product_visible(product, active_category_ids(self._repos.categories.list()), settings):
            raise NotFound("Produto não encontrado.")
        return product


class CategoryService:
    def __init__(self, repos: Repositories, ids: IdFactory = new_id) -> None:
        self._repos = repos
        self._ids = ids

    def list(self) -> list[Category]:
        return sorted(self._repos.categories.list(), key=lambda c: normalize_text(c.name))

    def create(self, data: CategoryCreate) -> Category:
        category = Category(id=self._ids(), name=data.name, icon=data.icon, active=True)
        self._save(category)
        return category

    def update(self, category_id: str, data: CategoryUpdate) -> Category:
        current = self._repos.categories.get(category_id)
        if current is None:
            raise NotFound("Categoria não encontrada.")
        updated = replace(current, **data.changes())
        self._save(updated)
        return updated

    def _save(self, category: Category) -> None:
        # A unicidade do nome é garantida atomicamente pelo repositório (não por consulta prévia).
        try:
            self._repos.categories.save(category)
        except CategoryNameTaken:
            raise Conflict(
                "Já existe uma categoria com esse nome.", field_errors={"name": "Já existe uma categoria com esse nome."}
            ) from None


class ProductService:
    def __init__(self, repos: Repositories, clock: Clock = utc_now, ids: IdFactory = new_id) -> None:
        self._repos = repos
        self._clock = clock
        self._ids = ids

    def list(self) -> list[Product]:
        return sorted(self._repos.products.list(), key=lambda p: p.created_at, reverse=True)

    def get(self, product_id: str) -> Product:
        product = self._repos.products.get(product_id)
        if product is None:
            raise NotFound("Produto não encontrado.")
        return product

    def create(self, data: ProductCreate, actor_uid: str) -> Product:
        # A foto chega depois, por `PUT /products/{id}/image`: o produto precisa existir antes.
        if data.image_url:
            raise ValidationFailed(IMAGE_VIA_UPLOAD, field_errors={"imageUrl": IMAGE_VIA_UPLOAD})
        self._ensure_category(data.category_id)
        _ensure_price_rule(data.show_price, data.price_cents)
        now = self._clock()
        product = Product(
            id=self._ids(),
            name=data.name,
            description=data.description,
            category_id=data.category_id,
            brand=data.brand,
            image_url=data.image_url,
            price_cents=data.price_cents,
            show_price=data.show_price,
            stock=data.stock,
            min_stock=data.min_stock,
            published=data.published,
            featured=data.featured,
            archived=False,
            created_at=now,
            updated_at=now,
        )
        movement = initial_stock_movement(product, movement_id=self._ids(), actor_uid=actor_uid)

        def write(tx: InventoryTransaction) -> Product:
            tx.put_product(product)
            if movement:
                tx.add_movements([movement])
            return product

        return self._repos.inventory.run_in_transaction(write)

    def update(self, product_id: str, data: ProductUpdate) -> Product:
        changes = data.changes()
        if "category_id" in changes:
            self._ensure_category(changes["category_id"])
        now = self._clock()

        def write(tx: InventoryTransaction) -> Product:
            # Relido dentro da transação: a edição nunca sobrescreve um estoque alterado em paralelo.
            current = tx.get_products([product_id]).get(product_id)
            if current is None:
                raise NotFound("Produto não encontrado.")
            # URL e objeto da foto mudam juntos, só pelas rotas de imagem; reenviar a URL atual é aceito (sem efeito).
            fields = dict(changes)  # cópia: a função pode ser reexecutada pela transação
            if fields.pop("image_url", current.image_url) != current.image_url:
                raise ValidationFailed(IMAGE_VIA_UPLOAD, field_errors={"imageUrl": IMAGE_VIA_UPLOAD})
            updated = replace(current, **fields, updated_at=now)
            if updated.archived:
                updated = replace(updated, published=False)  # arquivado nunca fica publicado
            _ensure_price_rule(updated.show_price, updated.price_cents)
            tx.put_product(updated)
            return updated

        return self._repos.inventory.run_in_transaction(write)

    def _ensure_category(self, category_id: str) -> None:
        if self._repos.categories.get(category_id) is None:
            raise ValidationFailed("Categoria inexistente.", field_errors={"categoryId": "Categoria inexistente."})


def _ensure_price_rule(show_price: bool, price_cents: int | None) -> None:
    if show_price and price_cents is None:
        raise ValidationFailed(PRICE_REQUIRED, field_errors={"priceCents": PRICE_REQUIRED})
