import re


def slugify(value: str) -> str:
    normalized = value.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    return normalized.strip("-")


def compact_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def title_case(value: str) -> str:
    return " ".join(part.capitalize() for part in compact_whitespace(value).split(" "))
