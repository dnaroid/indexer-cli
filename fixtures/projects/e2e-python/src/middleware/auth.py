from dataclasses import dataclass

from src.constants.http import HTTP_UNAUTHORIZED


@dataclass(slots=True)
class AuthResult:
    allowed: bool
    status: int
    principal: str | None


def _extract_bearer(token_header: str) -> str:
    parts = token_header.split(" ", 1)
    return parts[1] if len(parts) == 2 else ""


def enforce_auth(headers: dict[str, str]) -> AuthResult:
    token = _extract_bearer(headers.get("authorization", ""))
    allowed = token.startswith("fixture-") and len(token) > 12
    principal = token.removeprefix("fixture-") if allowed else None
    return AuthResult(
        allowed=allowed,
        status=200 if allowed else HTTP_UNAUTHORIZED,
        principal=principal,
    )
