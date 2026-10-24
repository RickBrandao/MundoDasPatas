"""DTOs de configurações da loja, catálogo público agregado, dashboard e health check."""

from typing import Literal

from app.domain.models import StoreSettings
from app.schemas.catalog import PublicCategory, PublicProduct
from app.schemas.common import ApiModel, InputModel, text


class SettingsOut(ApiModel):
    store_name: str
    whatsapp: str
    address: str
    hours: str
    about: str
    show_out_of_stock: bool
    show_featured: bool


class SettingsIn(InputModel):
    """Substituição completa (PUT). O WhatsApp é validado como número brasileiro com DDD."""

    store_name: text(80, 1)
    whatsapp: text(30, 1)
    address: text(200) = ""
    hours: text(200) = ""
    about: text(2000) = ""
    show_out_of_stock: bool
    show_featured: bool


class PublicStore(ApiModel):
    """Informações comerciais públicas. `showOutOfStock` é aplicado no servidor e não é exposto."""

    store_name: str
    whatsapp: str
    address: str
    hours: str
    about: str
    show_featured: bool

    @classmethod
    def from_domain(cls, s: StoreSettings) -> "PublicStore":
        return cls.model_validate(s)


class PublicCatalog(ApiModel):
    """Tudo o que a vitrine precisa em uma única chamada."""

    store: PublicStore
    categories: list[PublicCategory]
    products: list[PublicProduct]


class CatalogSummary(ApiModel):
    active: int
    visible: int
    published: int
    not_published: int
    hidden_by_category: int
    hidden_out_of_stock: int
    inactive_categories: int
    ok: int
    low: int
    out: int


class SalesSummary(ApiModel):
    count: int
    units: int


class LowStockItem(ApiModel):
    id: str
    name: str
    stock: int
    min_stock: int


class DashboardOut(ApiModel):
    catalog: CatalogSummary
    sales_last_7_days: SalesSummary
    sales_last_30_days: SalesSummary
    low_stock: list[LowStockItem]


class DependencyStatus(ApiModel):
    status: Literal["configured", "not_configured", "ephemeral", "emulator", "disabled"]
    detail: str


class HealthOut(ApiModel):
    # Saúde do processo. As dependências são descritas pela configuração, sem chamadas externas:
    # "configured" não significa "verificado e operacional".
    status: Literal["ok"]
    environment: str
    version: str
    dependencies: dict[str, DependencyStatus]
