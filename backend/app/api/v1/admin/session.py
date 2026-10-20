"""Sessão administrativa: permite ao frontend confirmar a autorização antes de abrir o painel.

Não usa repositórios nem serviços de dados: responde mesmo sem persistência configurada.
"""

from fastapi import APIRouter

from app.api.dependencies import AdminDep
from app.schemas.session import AdminMeOut

router = APIRouter()


@router.get("/me", tags=["Admin · Sessão"], summary="Confirmar a autorização administrativa do token enviado")
def get_me(admin: AdminDep) -> AdminMeOut:
    # `admin` vem de `require_admin` (a mesma dependência do roteador, avaliada uma vez por requisição).
    return AdminMeOut(uid=admin.uid)
