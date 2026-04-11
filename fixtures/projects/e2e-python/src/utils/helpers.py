from src.helpers.pagination import paginate
from src.helpers.strings import slugify


def build_engine_id(app_name: str, environment: str) -> str:
    return f"{slugify(app_name)}-{slugify(environment)}"


def select_page(players: list[dict[str, str]], page: int) -> object:
    return paginate(players, page=page)
