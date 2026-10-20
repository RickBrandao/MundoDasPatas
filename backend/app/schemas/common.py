"""Base dos DTOs HTTP.

Serialização: JSON em camelCase (compatível com o frontend: `categoryId`, `priceCents`,
`createdAt`), atributos Python em snake_case. Datas em ISO 8601 UTC (`...Z`).
Entradas rejeitam campos desconhecidos (`extra="forbid"`): o cliente não consegue enviar
campos controlados pelo servidor (estoque na edição, `createdBy`, timestamps etc.).
"""

from datetime import UTC, datetime
from typing import Annotated, Any, ClassVar

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel


def _to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


UtcDatetime = Annotated[AwareDatetime, AfterValidator(_to_utc)]

# Inteiros estritos: "5", 5.0 e true são rejeitados.
StrictNonNegInt = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]
StrictPositiveQty = Annotated[int, Field(strict=True, gt=0, le=10_000)]
PriceCents = Annotated[int, Field(strict=True, gt=0, le=100_000_000)]

Id = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


def text(max_length: int, min_length: int = 0) -> Any:
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)]


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        from_attributes=True,
    )


class InputModel(ApiModel):
    model_config = ConfigDict(extra="forbid")


class PatchModel(InputModel):
    """PATCH parcial: só os campos enviados são aplicados; `null` só onde o campo admite ausência."""

    # Nomes JSON (camelCase) que aceitam null explicitamente.
    nullable_fields: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _reject_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            invalid = [k for k, v in data.items() if v is None and k not in cls.nullable_fields]
            if invalid:
                raise ValueError(f"Campos não aceitam null: {', '.join(sorted(invalid))}.")
            if not data:
                raise ValueError("Informe ao menos um campo para alterar.")
        return data

    def changes(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.model_fields_set}
