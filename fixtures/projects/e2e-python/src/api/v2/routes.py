from src.core.engine import build_engine
from src.types.api import APIRequest, APIResponse


def build_routes() -> tuple[str, ...]:
    return ("/api/v2/login", "/api/v2/engine")


def handle_v2_request(request: APIRequest) -> APIResponse:
    from src.middleware.auth import enforce_auth
    from src.services.auth import issue_identity

    auth = enforce_auth(request.headers)
    identity = issue_identity("v2@example.com", ["api"])
    engine = build_engine([{"id": identity.user_id, "name": "V2 User", "role": "api"}])
    return APIResponse(
        status=200 if auth.allowed else auth.status,
        body={"engine": engine, "routes": build_routes(), "principal": auth.principal},
        headers={"x-api-version": "v2"},
    )
