class AppError(Exception):
    def __init__(self, message: str, *, code: str = "app_error") -> None:
        super().__init__(message)
        self.code = code


class NotFoundError(AppError):
    def __init__(self, message: str, *, resource_id: str) -> None:
        super().__init__(message, code="not_found")
        self.resource_id = resource_id


class ValidationError(AppError):
    def __init__(self, message: str, *, field: str) -> None:
        super().__init__(message, code="validation_error")
        self.field = field


def format_error(error: AppError) -> dict[str, str]:
    return {"message": str(error), "code": error.code}
