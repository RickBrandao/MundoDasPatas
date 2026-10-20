"""Normalização de WhatsApp brasileiro — espelha `src/domain/phone.ts`."""

import re
from dataclasses import dataclass

_ALLOWED = re.compile(r"[^\d\s()+\-.]")


@dataclass(frozen=True, slots=True)
class Phone:
    national: str
    e164: str


class InvalidPhone(ValueError):
    pass


def normalize_phone(raw_input: str) -> Phone:
    raw = raw_input.strip()
    if not raw:
        raise InvalidPhone("Informe o WhatsApp com DDD.")
    if _ALLOWED.search(raw):
        raise InvalidPhone("Use apenas números, espaços, parênteses, hífen e +.")

    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        if not digits.startswith("55") or len(digits) not in (12, 13):
            raise InvalidPhone("Somente números do Brasil (+55) com DDD são aceitos.")
        digits = digits[2:]
    else:
        if digits.startswith("0"):
            digits = digits[1:]
        if len(digits) in (12, 13) and digits.startswith("55"):
            digits = digits[2:]

    if len(digits) not in (10, 11):
        raise InvalidPhone("Informe DDD + número (10 ou 11 dígitos).")
    if digits[0] == "0" or digits[1] == "0":
        raise InvalidPhone("DDD inválido.")
    if len(digits) == 11 and digits[2] != "9":
        raise InvalidPhone("Celular com 11 dígitos deve ter 9 após o DDD.")
    return Phone(national=digits, e164="55" + digits)
