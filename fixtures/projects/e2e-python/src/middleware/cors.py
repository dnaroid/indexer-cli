from dataclasses import dataclass

from src.constants.http import HTTP_NO_CONTENT


@dataclass(slots=True)
class CorsPolicy:
    allow_origin: str
    allow_methods: tuple[str, ...]


DEFAULT_POLICY = CorsPolicy(allow_origin="*", allow_methods=("GET", "POST", "OPTIONS"))


def build_preflight_headers(
    origin: str, policy: CorsPolicy = DEFAULT_POLICY
) -> tuple[int, dict[str, str]]:
    headers = {
        "access-control-allow-origin": origin or policy.allow_origin,
        "access-control-allow-methods": ", ".join(policy.allow_methods),
    }
    return HTTP_NO_CONTENT, headers
