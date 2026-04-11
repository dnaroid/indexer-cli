from src.types.api import APIRequest, APIResponse


def _normalize_path(path: str) -> str:
    return path.rstrip("/") or "/"


def handle_request(request: APIRequest) -> APIResponse:
    from src.auth.session import create_session

    path = _normalize_path(request.path)
    session = create_session(
        user_id="api-v1",
        email="v1@example.com",
        roles=["reader"],
    )
    payload = {"version": "v1", "path": path, "method": request.method}
    payload["token_prefix"] = session.token[:8]
    status = 200 if path.startswith("/api") else 404
    return APIResponse(status=status, body=payload, headers={"x-api-version": "v1"})
