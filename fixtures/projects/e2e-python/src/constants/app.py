APP_NAME = "fixture-shop"
DEFAULT_REGION = "us-east-1"
SUPPORTED_PAYMENT_PROVIDERS = ("stripe", "manual")
DEFAULT_PAGE_SIZE = 25


def build_runtime_name(environment: str) -> str:
    label = environment.strip().lower() or "development"
    return f"{APP_NAME}-{label}"


def is_supported_provider(provider: str) -> bool:
    return provider in SUPPORTED_PAYMENT_PROVIDERS
