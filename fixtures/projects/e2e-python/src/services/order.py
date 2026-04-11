from dataclasses import dataclass

from src.payments.processor import PaymentProcessor, PaymentRequest, process_payment
from src.utils.errors import NotFoundError, ValidationError


@dataclass(slots=True)
class OrderValidator:
    allowed_currencies: tuple[str, ...] = ("USD", "EUR")

    def validate_order(self, payload: dict[str, object]) -> dict[str, object]:
        user_id = str(payload.get("user_id", "")).strip()
        items = payload.get("items", [])
        currency = str(payload.get("currency", "")).upper()
        if not user_id:
            raise ValidationError("orders require a user id", field="user_id")
        if not isinstance(items, list) or not items:
            raise ValidationError("orders require at least one item", field="items")
        if currency not in self.allowed_currencies:
            raise ValidationError("unsupported order currency", field="currency")
        return {"user_id": user_id, "items": items, "currency": currency}


def validate_order(payload: dict[str, object]) -> dict[str, object]:
    return OrderValidator().validate_order(payload)


def create_order(
    payload: dict[str, object],
    user: dict[str, object] | None,
    processor: PaymentProcessor,
) -> dict[str, object]:
    normalized = validate_order(payload)
    if user is None or user.get("id") != normalized["user_id"]:
        raise NotFoundError(
            "user not found for order", resource_id=str(normalized["user_id"])
        )
    amount = sum(
        float(item["price"]) * int(item["quantity"]) for item in normalized["items"]
    )
    request = PaymentRequest(
        amount=amount,
        currency=str(normalized["currency"]),
        reference=f"order-{normalized['user_id']}",
    )
    receipt = process_payment(processor, request)
    return {
        "id": f"order-{normalized['user_id']}",
        "amount": amount,
        "currency": normalized["currency"],
        "receipt": receipt,
        "status": "paid",
    }
