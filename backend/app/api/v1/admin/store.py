from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.dependencies import get_dashboard_service, get_settings_service
from app.schemas.store import DashboardOut, SettingsIn, SettingsOut
from app.services.store import DashboardService, SettingsService

router = APIRouter()

SettingsServiceDep = Annotated[SettingsService, Depends(get_settings_service)]


@router.get("/dashboard", tags=["Admin · Dashboard"], summary="Resumo do catálogo, estoque e vendas")
def get_dashboard(dashboard: Annotated[DashboardService, Depends(get_dashboard_service)]) -> DashboardOut:
    return dashboard.summary()


@router.get("/settings", tags=["Admin · Configurações"], summary="Configurações da loja")
def get_store_settings(service: SettingsServiceDep) -> SettingsOut:
    return SettingsOut.model_validate(service.get())


@router.put("/settings", tags=["Admin · Configurações"], summary="Substituir configurações da loja")
def put_store_settings(data: SettingsIn, service: SettingsServiceDep) -> SettingsOut:
    return SettingsOut.model_validate(service.save(data))
