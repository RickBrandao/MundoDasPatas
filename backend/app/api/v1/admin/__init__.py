"""API administrativa. A autenticação é aplicada no roteador: nenhuma rota daqui fica sem proteção."""

from fastapi import APIRouter, Depends

from app.api.dependencies import require_admin
from app.api.v1.admin import catalog, inventory, store

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
router.include_router(catalog.router)
router.include_router(inventory.router)
router.include_router(store.router)
