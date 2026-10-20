"""DTO da sessão administrativa."""

from app.schemas.common import ApiModel


class AdminMeOut(ApiModel):
    # Somente o UID extraído do token verificado: nenhum outro dado do usuário sai do servidor.
    uid: str
