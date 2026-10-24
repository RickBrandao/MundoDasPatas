"""Fotos dos produtos (ver `services/images.py` e docs/storage.md).

O arquivo vai no corpo da requisição, sem multipart (`Content-Type: image/jpeg|png|webp`), limitado a
`MAX_UPLOAD_BYTES`. A autenticação do roteador acontece antes de o corpo ser lido; um `Content-Length`
acima do limite é recusado sem leitura e a leitura é interrompida assim que o limite é ultrapassado.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import get_image_service
from app.core.errors import PayloadTooLarge, UnsupportedMediaType
from app.schemas.catalog import ImageUploadConfigOut, ProductAdminOut
from app.services.image_processing import ACCEPTED_TYPES, MAX_STORED_SIDE, MAX_UPLOAD_BYTES
from app.services.images import ProductImageService

router = APIRouter()

ImagesDep = Annotated[ProductImageService, Depends(get_image_service)]
# Mesmo formato dos IDs do servidor: nenhum caractere que altere o caminho no Storage ("/", "..", "%").
ProductId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > limit):
        raise PayloadTooLarge()
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise PayloadTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


@router.get("/images/config", tags=["Admin · Fotos"], summary="Envio de fotos disponível e seus limites")
def image_config(images: ImagesDep) -> ImageUploadConfigOut:
    return ImageUploadConfigOut(
        available=images.status(), max_bytes=MAX_UPLOAD_BYTES, accepted_types=list(ACCEPTED_TYPES), max_side=MAX_STORED_SIDE
    )


@router.put(
    "/products/{product_id}/image",
    tags=["Admin · Fotos"],
    summary="Enviar ou substituir a foto do produto (corpo: bytes da imagem)",
    responses={413: {"description": "Arquivo acima do limite"}, 415: {"description": "Tipo não aceito"}},
)
async def upload_image(product_id: ProductId, request: Request, images: ImagesDep) -> ProductAdminOut:
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in ACCEPTED_TYPES:
        raise UnsupportedMediaType()
    data = await _read_body(request, MAX_UPLOAD_BYTES)
    # Decodificação da imagem e chamadas ao Storage/Firestore são bloqueantes: fora do loop de eventos.
    product = await run_in_threadpool(images.upload, product_id, data, content_type)
    return ProductAdminOut.from_domain(product)


@router.delete("/products/{product_id}/image", tags=["Admin · Fotos"], summary="Remover a foto do produto")
def remove_image(product_id: ProductId, images: ImagesDep) -> ProductAdminOut:
    return ProductAdminOut.from_domain(images.remove(product_id))
