"""Autenticação (Firebase ID Token) e autorização administrativa.

Fluxo de toda rota administrativa (ver `app.api.dependencies.require_admin`):

1. Sem `Authorization: Bearer <token>`           → 401
2. Firebase não configurado, credenciais inválidas ou serviço indisponível → 503
   (fail-closed: nunca libera por omissão)
3. Token inválido, expirado, revogado, de outro projeto ou de usuário desativado/excluído → 401
4. UID fora da lista `ADMIN_ALLOWED_UIDS`        → 403
5. Caso contrário, a rota recebe um `AdminPrincipal` com o UID verificado.

A autorização usa apenas o UID extraído do token assinado pelo Google. Nada enviado pelo
navegador (cabeçalhos, corpo, claims "role" do cliente) é considerado.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from app.core.config import Settings
from app.core.errors import Forbidden, ServiceUnavailable, Unauthorized
from app.core.firebase import get_firebase_app

logger = logging.getLogger("app.security")


@dataclass(frozen=True, slots=True)
class VerifiedToken:
    uid: str
    claims: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class AdminPrincipal:
    uid: str


class InvalidToken(Exception):
    pass


class TokenVerifier(Protocol):
    def verify(self, id_token: str) -> VerifiedToken:
        """Devolve o token verificado ou levanta `InvalidToken`."""
        ...


class FirebaseTokenVerifier:
    """Classifica os erros do Firebase Admin SDK (7.x):

    - 401 (`InvalidToken`): o token ou a identidade não valem — inválido, expirado, revogado,
      de outro projeto (`InvalidIdTokenError` e subclasses), usuário desativado ou excluído.
    - 503: o servidor não conseguiu verificar — rede, timeout, certificados, credenciais
      administrativas ausentes/recusadas (`google.auth`, `Unauthenticated`, `PermissionDenied`).
    - Qualquer outro erro não é capturado e vira 500. Em todos os casos o acesso é negado.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def verify(self, id_token: str) -> VerifiedToken:
        from firebase_admin import auth
        from firebase_admin import exceptions as firebase_errors
        from google.auth import exceptions as google_auth_errors

        operational = (
            firebase_errors.UnavailableError,
            firebase_errors.DeadlineExceededError,
            # Inclui CertificateFetchError e falhas de transporte sem código HTTP.
            firebase_errors.UnknownError,
            firebase_errors.InternalError,
            firebase_errors.ResourceExhaustedError,
            # Credenciais administrativas inválidas ou sem permissão (consulta de revogação).
            firebase_errors.UnauthenticatedError,
            firebase_errors.PermissionDeniedError,
            # ADC indisponível, credencial malformada, falha ao renovar o access token.
            google_auth_errors.GoogleAuthError,
        )
        app = get_firebase_app(self._settings)
        try:
            # check_revoked: um usuário desativado ou com sessão revogada perde o acesso imediatamente.
            claims = auth.verify_id_token(id_token, app=app, check_revoked=True)
        except (auth.InvalidIdTokenError, auth.UserDisabledError, auth.UserNotFoundError) as exc:
            # Registra só o tipo do erro: a mensagem pode conter partes do token.
            logger.info("Token recusado: %s", type(exc).__name__)
            raise InvalidToken() from None
        except operational as exc:
            # Antes de ValueError: alguns erros de credencial do google.auth também são ValueError.
            logger.error("Falha operacional ao verificar o token no Firebase: %s", type(exc).__name__)
            raise ServiceUnavailable("Autenticação indisponível no momento.") from None
        except ValueError as exc:
            # Token que não é uma string JWT utilizável.
            logger.info("Token recusado: %s", type(exc).__name__)
            raise InvalidToken() from None
        return VerifiedToken(uid=claims["uid"], claims=claims)


def authorize_admin(token: VerifiedToken, settings: Settings) -> AdminPrincipal:
    """Allowlist de UIDs mantida no ambiente do servidor (alterável apenas por quem administra o deploy)."""
    if token.uid not in settings.admin_allowed_uids:
        logger.warning("Acesso administrativo negado para uid=%s", token.uid)
        raise Forbidden()
    return AdminPrincipal(uid=token.uid)


def authenticate_admin(raw_token: str | None, verifier: TokenVerifier | None, settings: Settings) -> AdminPrincipal:
    if not raw_token:
        raise Unauthorized()
    if verifier is None:
        raise ServiceUnavailable("Autenticação indisponível no momento.")
    try:
        token = verifier.verify(raw_token)
    except InvalidToken:
        raise Unauthorized("Sessão inválida ou expirada. Entre novamente.") from None
    return authorize_admin(token, settings)
