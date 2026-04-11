from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class APIRequest:
    method: str
    path: str
    headers: dict[str, str] = field(default_factory=dict)
    body: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class APIResponse:
    status: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=dict)


def ok(body: dict[str, Any]) -> APIResponse:
    return APIResponse(status=200, body=body)
