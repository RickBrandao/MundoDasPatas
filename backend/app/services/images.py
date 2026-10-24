"""Fotos dos produtos: envio, substituição, remoção e limpeza de objetos órfãos.

Regras de propriedade (nenhum caminho vem do navegador):
- o caminho é montado no servidor: `products/{productId}/images/{imageId}.webp`, com `productId` do
  produto existente e `imageId` aleatório (128 bits) — nunca colide nem sobrescreve outra foto;
- o produto guarda o caminho do seu objeto (`image_path`, interno); um objeto só é excluído como
  "foto anterior" se era exatamente o `image_path` lido na transação que o substituiu, e só dentro
  do prefixo do próprio produto;
- a limpeza de órfãos só exclui objetos com caminho no formato acima, com metadado `productId`
  igual ao do caminho, que não são a foto atual do produto e que já passaram do período de carência
  (`ORPHAN_GRACE`: protege envios em andamento). Qualquer outro objeto do bucket é ignorado.

Ordem do envio (o produto só muda depois que a nova foto existe):
1. confere o produto (404 antes de processar/enviar);
2. valida e recodifica (`image_processing`), grava o objeto novo;
3. transação no banco: aponta o produto para a nova foto (relendo o produto);
4. exclui a foto anterior (melhor esforço: se falhar, vira órfã e a limpeza a remove depois).
Se a etapa 3 falhar, o objeto novo é excluído — exceto se uma releitura mostrar que a gravação
chegou a acontecer (resultado incerto). Se nem a releitura for possível, o objeto fica para a limpeza.
Assim, uma falha nunca deixa o produto apontando para uma foto inexistente nem perde a foto anterior.
"""

import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import timedelta

from app.core.errors import ApiError, NotFound
from app.core.storage import StorageNotConfigured, StorageUnavailable
from app.domain.models import Product
from app.repositories.base import InventoryTransaction, Repositories
from app.services.common import Clock, IdFactory, new_id, utc_now
from app.services.image_processing import STORED_CONTENT_TYPE, process_image
from app.storage.base import ObjectStore
from app.storage.firebase import TOKEN_METADATA

logger = logging.getLogger("app.images")

PRODUCTS_PREFIX = "products/"
IMAGE_PATH = re.compile(r"^products/(?P<product_id>[A-Za-z0-9_-]{1,64})/images/(?P<image_id>[0-9a-f]{32})\.webp$")
# O nome do objeto muda a cada envio: o navegador e a CDN podem guardar a foto por um ano.
CACHE_CONTROL = "public, max-age=31536000, immutable"
ORPHAN_GRACE = timedelta(hours=1)
OWNER_METADATA = "productId"


def image_path(product_id: str, image_id: str) -> str:
    path = f"products/{product_id}/images/{image_id}.webp"
    if not IMAGE_PATH.fullmatch(path):
        raise ValueError("identificadores inválidos para o caminho da imagem")
    return path


def owned_by(path: str, product_id: str) -> bool:
    match = IMAGE_PATH.fullmatch(path)
    return bool(match) and match["product_id"] == product_id  # type: ignore[index]


def new_token() -> str:
    return str(uuid.uuid4())


@dataclass
class CleanupReport:
    deleted: list[str] = field(default_factory=list)
    # Foto atual de um produto ou envio recente (dentro da carência).
    kept: list[str] = field(default_factory=list)
    # Fora do padrão ou sem prova de propriedade: nunca excluídos.
    ignored: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


class ProductImageService:
    def __init__(
        self,
        repos: Repositories,
        store: ObjectStore | None,
        clock: Clock = utc_now,
        ids: IdFactory = new_id,
        tokens: Callable[[], str] = new_token,
    ) -> None:
        self._repos = repos
        self._store = store
        self._clock = clock
        self._ids = ids
        self._tokens = tokens

    def _require_store(self) -> ObjectStore:
        # Configuração conferida antes de ler o produto ou abrir transação: com bucket, projeto ou
        # credencial recusados, nada é gravado no Storage nem no Firestore.
        if self._store is None or not self._store.ready():
            raise StorageNotConfigured()
        return self._store

    # ------------------------------------------------------------- envio

    def upload(self, product_id: str, data: bytes, content_type: str) -> Product:
        store = self._require_store()
        if self._repos.products.get(product_id) is None:
            raise NotFound("Produto não encontrado.")
        image = process_image(data, content_type)
        path = image_path(product_id, self._ids())
        token = self._tokens()
        store.put(
            path,
            image.data,
            content_type=STORED_CONTENT_TYPE,
            cache_control=CACHE_CONTROL,
            metadata={TOKEN_METADATA: token, OWNER_METADATA: product_id},
        )
        url = store.public_url(path, token)
        now = self._clock()

        def write(tx: InventoryTransaction) -> tuple[Product, Product]:
            current = tx.get_products([product_id]).get(product_id)
            if current is None:
                raise NotFound("Produto não encontrado.")
            updated = replace(current, image_url=url, image_path=path, updated_at=now)
            tx.put_product(updated)
            return current, updated

        try:
            previous, updated = self._repos.inventory.run_in_transaction(write)
        except Exception:
            self._discard_unattached(product_id, path)
            raise
        self._delete_replaced(product_id, previous.image_path, keep=path)
        return updated

    def _discard_unattached(self, product_id: str, path: str) -> None:
        """A associação falhou: exclui o objeto novo, a menos que o produto já aponte para ele."""
        try:
            current = self._repos.products.get(product_id)
        except ApiError:
            logger.warning("Associação da foto com resultado incerto; objeto mantido para a limpeza de órfãos.")
            return
        if current is not None and current.image_path == path:
            return
        try:
            self._store.delete(path)  # type: ignore[union-attr]
        except ApiError:
            logger.warning("Não foi possível excluir a foto não associada; fica para a limpeza de órfãos.")

    def _delete_replaced(self, product_id: str, old_path: str, keep: str = "") -> None:
        # Só o objeto registrado no próprio produto (lido na transação) e dentro do seu prefixo.
        if not old_path or old_path == keep or not owned_by(old_path, product_id) or self._store is None:
            if old_path and not owned_by(old_path, product_id):
                logger.warning("Foto anterior fora do prefixo do produto: não excluída.")
            return
        try:
            self._store.delete(old_path)
        except ApiError:
            logger.warning("Não foi possível excluir a foto anterior; fica para a limpeza de órfãos.")

    # ------------------------------------------------------------- remoção

    def remove(self, product_id: str) -> Product:
        if self._store is not None:
            self._require_store()  # Storage desligado (None) ainda permite desvincular; recusado, não.
        now = self._clock()

        def write(tx: InventoryTransaction) -> tuple[Product, Product]:
            current = tx.get_products([product_id]).get(product_id)
            if current is None:
                raise NotFound("Produto não encontrado.")
            if not current.image_url and not current.image_path:
                return current, current  # já sem foto: nada a gravar
            updated = replace(current, image_url="", image_path="", updated_at=now)
            tx.put_product(updated)
            return current, updated

        previous, updated = self._repos.inventory.run_in_transaction(write)
        if previous.image_path and self._store is None:
            logger.warning("Foto removida do produto com o Storage desligado; objeto fica para a limpeza de órfãos.")
        self._delete_replaced(product_id, previous.image_path)
        return updated

    # ------------------------------------------------------------- limpeza

    def cleanup_orphans(
        self, *, product_id: str | None = None, dry_run: bool = True, grace: timedelta = ORPHAN_GRACE
    ) -> CleanupReport:
        """Exclui fotos que nenhum produto usa (ver regras no topo do módulo). `dry_run` só relata."""
        store = self._require_store()
        prefix = f"{PRODUCTS_PREFIX}{product_id}/images/" if product_id else PRODUCTS_PREFIX
        objects = store.list(prefix)
        current_paths = {p.id: p.image_path for p in self._repos.products.list()}
        limit = self._clock() - grace
        report = CleanupReport()
        for obj in objects:
            match = IMAGE_PATH.fullmatch(obj.path)
            owner = match["product_id"] if match else None
            if owner is None or obj.metadata.get(OWNER_METADATA) != owner:
                report.ignored.append(obj.path)
            elif current_paths.get(owner) == obj.path or obj.created_at > limit:
                report.kept.append(obj.path)
            elif dry_run:
                report.deleted.append(obj.path)
            else:
                try:
                    store.delete(obj.path)
                    report.deleted.append(obj.path)
                except StorageUnavailable:
                    report.failed.append(obj.path)
        return report

    # ------------------------------------------------------------- situação

    def status(self) -> bool:
        """Envio disponível? Só confere a configuração (sem acesso à rede)."""
        return self._store is not None and self._store.ready()
