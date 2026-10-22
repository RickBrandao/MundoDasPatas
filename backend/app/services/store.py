"""Configurações da loja e resumo do dashboard."""

from app.core.errors import ValidationFailed
from app.domain.catalog import active_category_ids, is_product_visible, stock_status
from app.domain.models import Sale, SaleStatus, StockStatus, StoreSettings
from app.domain.phone import InvalidPhone, normalize_phone
from app.repositories.base import Repositories
from app.schemas.store import CatalogSummary, DashboardOut, LowStockItem, SalesSummary, SettingsIn
from app.services.catalog import load_settings
from app.services.inventory import InventoryService


class SettingsService:
    def __init__(self, repos: Repositories) -> None:
        self._repos = repos

    def get(self) -> StoreSettings:
        return load_settings(self._repos)

    def save(self, data: SettingsIn) -> StoreSettings:
        try:
            normalize_phone(data.whatsapp)
        except InvalidPhone as exc:
            raise ValidationFailed("Revise o número de WhatsApp.", field_errors={"whatsapp": str(exc)}) from None
        settings = StoreSettings(**data.model_dump(by_alias=False))
        self._repos.settings.save(settings)
        return settings


class DashboardService:
    def __init__(self, repos: Repositories, inventory: InventoryService) -> None:
        self._repos = repos
        self._inventory = inventory

    def summary(self) -> DashboardOut:
        settings = load_settings(self._repos)
        categories = self._repos.categories.list()
        active_ids = active_category_ids(categories)
        products = [p for p in self._repos.products.list() if not p.archived]

        counts = {s: 0 for s in StockStatus}
        for p in products:
            counts[stock_status(p)] += 1
        published = [p for p in products if p.published]
        catalog = CatalogSummary(
            active=len(products),
            visible=sum(is_product_visible(p, active_ids, settings) for p in products),
            published=len(published),
            not_published=len(products) - len(published),
            hidden_by_category=sum(p.category_id not in active_ids for p in published),
            hidden_out_of_stock=sum(
                p.category_id in active_ids and not settings.show_out_of_stock and p.stock <= 0 for p in published
            ),
            inactive_categories=sum(not c.active for c in categories),
            ok=counts[StockStatus.OK],
            low=counts[StockStatus.LOW],
            out=counts[StockStatus.OUT],
        )
        low_stock = sorted((p for p in products if stock_status(p) is not StockStatus.OK), key=lambda p: (p.stock, p.name))
        windows = self._inventory.sales_windows(7, 30)
        last_7, last_30 = windows[7], windows[30]
        return DashboardOut(
            catalog=catalog,
            sales_last_7_days=_sales_summary(last_7),
            sales_last_30_days=_sales_summary(last_30),
            low_stock=[LowStockItem.model_validate(p) for p in low_stock],
        )


def _sales_summary(sales: list[Sale]) -> SalesSummary:
    done = [s for s in sales if s.status is SaleStatus.CONCLUIDA]
    return SalesSummary(count=len(done), units=sum(i.qty for s in done for i in s.items))
