"""Produtos e categorias: catálogo público (somente leitura) e gestão administrativa."""

from dataclasses import replace

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.domain.catalog import active_category_ids, is_product_visible, normalize_text, visible_products
from app.domain.inventory import initial_stock_movement
from app.domain.models import DEFAULT_SETTINGS, Category, Product, StoreSettings
from app.repositories.base import InventoryTransaction, Repositories
from app.schemas.catalog import CategoryCreate, CategoryUpdate, ProductCreate, ProductUpdate
from app.services.common import Clock, IdFactory, new_id, utc_now

PRICE_REQUIRED = "Informe o preço ou desmarque “Exibir preço no catálogo”."


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
        self._ensure_unique_name(data.name, exclude_id=None)
        category = Category(id=self._ids(), name=data.name, icon=data.icon, active=True)
        self._repos.categories.save(category)
        return category

    def update(self, category_id: str, data: CategoryUpdate) -> Category:
        current = self._repos.categories.get(category_id)
        if current is None:
            raise NotFound("Categoria não encontrada.")
        changes = data.changes()
        if "name" in changes:
            self._ensure_unique_name(changes["name"], exclude_id=category_id)
        updated = replace(current, **changes)
        self._repos.categories.save(updated)
        return updated

    def _ensure_unique_name(self, name: str, exclude_id: str | None) -> None:
        # Sem transação: duas criações simultâneas com o mesmo nome são improváveis num painel
        # de poucos usuários. No Firestore, um índice de nome normalizado pode tornar isto estrito.
        key = normalize_text(name)
        if any(c.id != exclude_id and normalize_text(c.name) == key for c in self._repos.categories.list()):
            raise Conflict(
                "Já existe uma categoria com esse nome.", field_errors={"name": "Já existe uma categoria com esse nome."}
            )


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
            updated = replace(current, **changes, updated_at=now)
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
