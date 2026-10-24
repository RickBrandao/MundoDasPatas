"""Validação e normalização das fotos enviadas pelo painel.

O arquivo recebido nunca é gravado como veio. Etapas:
1. tamanho máximo (`MAX_UPLOAD_BYTES`, bem abaixo do limite de 4,5 MB das Vercel Functions);
2. assinatura binária (magic bytes) coerente com o `Content-Type` declarado: JPEG, PNG ou WebP;
   extensão e tipo informados pelo navegador não bastam (SVG, HTML, GIF, executáveis são recusados);
3. dimensões conferidas **antes** de decodificar os pixels (proteção contra "decompression bombs");
4. decodificação completa (arquivo truncado ou corrompido é recusado); animações são recusadas;
5. orientação EXIF aplicada e nova codificação em WebP, sem metadados (EXIF/GPS, ICC, XMP, comentários
   e qualquer conteúdo embutido ficam para trás).

Tudo em memória (o arquivo tem no máximo `MAX_UPLOAD_BYTES`): nada é escrito no disco da função.
"""

import io
import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.core.errors import ValidationFailed

if TYPE_CHECKING:
    from PIL.Image import Image as PilImage

# Corpo máximo aceito pela API. O painel envia ~100–400 KB (WebP até 1200 px) e nunca o original.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
# Lado máximo armazenado (o painel já reduz para 1200 px; maiores são reduzidos aqui).
MAX_STORED_SIDE = 1600
# Limites de entrada, conferidos antes de decodificar.
MAX_INPUT_SIDE = 8000
MAX_INPUT_PIXELS = 40_000_000
WEBP_QUALITY = 82

ACCEPTED_TYPES = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
STORED_CONTENT_TYPE = "image/webp"


class InvalidImage(ValidationFailed):
    code = "invalid_image"
    message = "A imagem não pôde ser processada. Use um arquivo JPEG, PNG ou WebP válido."

    def __init__(self, message: str | None = None) -> None:
        msg = message or self.message
        super().__init__(msg, field_errors={"image": msg})


@dataclass(frozen=True, slots=True)
class ProcessedImage:
    data: bytes
    width: int
    height: int
    content_type: str = STORED_CONTENT_TYPE


def sniff_format(data: bytes) -> str | None:
    """Formato pela assinatura binária (não confia em extensão nem em Content-Type)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def process_image(data: bytes, declared_type: str) -> ProcessedImage:
    """Valida e recodifica em WebP. Levanta `InvalidImage` (422) com mensagem para o usuário."""
    expected = ACCEPTED_TYPES.get(declared_type)
    if expected is None:
        raise InvalidImage("Formato não suportado. Use JPEG, PNG ou WebP.")
    if not data:
        raise InvalidImage("Arquivo vazio.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise InvalidImage("Imagem grande demais para envio.")
    if sniff_format(data) != expected:
        raise InvalidImage("O conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WebP válida.")

    from PIL import Image, ImageOps

    try:
        with warnings.catch_warnings():
            # DecompressionBombWarning vira erro: nenhuma imagem gigante chega a ser decodificada.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=[expected]) as img:
                width, height = img.size
                if width < 1 or height < 1 or max(width, height) > MAX_INPUT_SIDE or width * height > MAX_INPUT_PIXELS:
                    raise InvalidImage("Dimensões da imagem fora do permitido.")
                if getattr(img, "is_animated", False):
                    raise InvalidImage("Imagens animadas não são aceitas.")
                img.load()
                out = _normalize(ImageOps.exif_transpose(img))
                buf = io.BytesIO()
                # Sem exif/icc_profile/xmp: o arquivo gravado não leva metadados do original.
                out.save(buf, format="WEBP", quality=WEBP_QUALITY, method=4)
    except InvalidImage:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InvalidImage("Dimensões da imagem fora do permitido.") from None
    except (OSError, ValueError, SyntaxError, MemoryError):
        # Arquivo truncado, corrompido ou malicioso; a mensagem do Pillow não é repassada.
        raise InvalidImage() from None
    return ProcessedImage(data=buf.getvalue(), width=out.width, height=out.height)


def _normalize(img: "PilImage") -> "PilImage":
    from PIL import Image

    has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    if max(img.size) > MAX_STORED_SIDE:
        img.thumbnail((MAX_STORED_SIDE, MAX_STORED_SIDE), Image.Resampling.LANCZOS)
    return img
