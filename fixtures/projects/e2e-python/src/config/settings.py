from dataclasses import dataclass
import os

from src.constants.app import APP_NAME, build_runtime_name


@dataclass(slots=True)
class Settings:
    app_name: str
    debug: bool
    payment_token: str
    environment: str


def load_settings(env: dict[str, str] | None = None) -> Settings:
    values = env or os.environ
    environment = values.get("APP_ENV", "development")
    debug = values.get("APP_DEBUG", "0") == "1"
    payment_token = values.get("PAYMENT_TOKEN", "sk_test_fixture")
    return Settings(
        app_name=build_runtime_name(environment) or APP_NAME,
        debug=debug,
        payment_token=payment_token,
        environment=environment,
    )
