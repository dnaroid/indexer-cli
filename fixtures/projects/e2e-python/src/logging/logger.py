from dataclasses import dataclass
from typing import Protocol
import json


class ContextWriter(Protocol):
    def write(self, payload: str) -> None: ...


@dataclass(slots=True)
class AppLogger:
    debug: bool
    last_event: str = ""

    def info(self, message: str, **context: object) -> None:
        self.last_event = self._format_event("info", message, context)

    def error(self, message: str, **context: object) -> None:
        self.last_event = self._format_event("error", message, context)

    def _format_event(
        self, level: str, message: str, context: dict[str, object]
    ) -> str:
        payload = {
            "level": level,
            "message": message,
            "context": context,
            "debug": self.debug,
        }
        return json.dumps(payload, sort_keys=True, default=str)
