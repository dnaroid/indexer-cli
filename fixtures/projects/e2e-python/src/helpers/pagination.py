from dataclasses import dataclass

from src.constants.app import DEFAULT_PAGE_SIZE


@dataclass(slots=True)
class Page:
    items: list[dict[str, str]]
    page: int
    page_size: int
    total: int


def paginate(
    items: list[dict[str, str]], page: int, page_size: int = DEFAULT_PAGE_SIZE
) -> Page:
    start = max(0, (page - 1) * page_size)
    end = start + page_size
    return Page(
        items=items[start:end], page=page, page_size=page_size, total=len(items)
    )
