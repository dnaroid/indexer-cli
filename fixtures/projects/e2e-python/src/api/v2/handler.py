from src.types.api import APIRequest, APIResponse


def _build_meta(path: str) -> dict[str, str]:
    return {"version": "v2", "resource": path.split("/")[-1] or "root"}


def handle_request(request: APIRequest) -> APIResponse:
    meta = _build_meta(request.path)
    body = {
        "version": meta["version"],
        "method": request.method,
        "resource": meta["resource"],
    }
    status = 202 if request.method == "POST" else 200
    return APIResponse(status=status, body=body, headers={"x-api-version": "v2"})
