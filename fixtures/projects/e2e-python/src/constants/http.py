HTTP_OK = 200
HTTP_ACCEPTED = 202
HTTP_NO_CONTENT = 204
HTTP_UNAUTHORIZED = 401
HTTP_NOT_FOUND = 404
HTTP_UNPROCESSABLE_ENTITY = 422


def is_error_status(status: int) -> bool:
    return status >= 400


def is_success_status(status: int) -> bool:
    return 200 <= status < 300
