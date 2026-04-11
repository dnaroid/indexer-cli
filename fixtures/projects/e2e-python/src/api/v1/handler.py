from src.types.api import APIRequest, APIResponse


def _normalize_path(path: str) -> str:
    return path.rstrip("/") or "/"


def handle_request(request: APIRequest) -> APIResponse:
    path = _normalize_path(request.path)
    payload = {"version": "v1", "path": path, "method": request.method}
    status = 200 if path.startswith("/api") else 404
    return APIResponse(status=status, body=payload, headers={"x-api-version": "v1"})
