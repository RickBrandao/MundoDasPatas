from fastapi import APIRouter

from app.api.v1 import admin, public

router = APIRouter(prefix="/api/v1")
router.include_router(public.router)
router.include_router(admin.router)
