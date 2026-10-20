"""Logs em JSON de uma linha (legíveis nos logs da Vercel). Nunca registrar tokens ou credenciais.

Tracebacks nunca são gravados: a mensagem da exceção e os valores citados nas linhas de código
podem conter dados sensíveis. Se um registro trouxer `exc_info`, só o tipo da exceção é incluído.
"""

import json
import logging
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0] is not None:
            entry["exceptionType"] = record.exc_info[0].__qualname__
        return json.dumps(entry, ensure_ascii=False)


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    app_logger = logging.getLogger("app")
    app_logger.handlers[:] = [handler]
    app_logger.setLevel(level.upper())
    app_logger.propagate = False
