from src.auth.session import create_session, validate_token
from src.config.settings import load_settings
from src.logging.logger import AppLogger
from src.payments.stripe import StripeProcessor
from src.services.order import create_order
from src.services.user import create_user


def bootstrap(command: str = "serve") -> dict[str, str | bool]:
    settings = load_settings()
    logger = AppLogger(settings.debug)
    user = create_user(
        {
            "email": "ava@example.com",
            "name": "Ava Carter",
            "password": "secret-pass-123",
        }
    )
    session = create_session(user_id=user["id"], email=user["email"], roles=["admin"])
    if not validate_token(session.token):
        raise RuntimeError("bootstrap session token is invalid")

    processor = StripeProcessor(api_key=settings.payment_token)
    order = create_order(
        {
            "user_id": user["id"],
            "currency": "USD",
            "items": [{"sku": "keyboard", "price": 129.0, "quantity": 1}],
        },
        user=user,
        processor=processor,
    )
    logger.info("application bootstrap complete", order_id=order["id"], command=command)
    return {"name": settings.app_name, "mode": command, "healthy": True}


if __name__ == "__main__":
    bootstrap()
