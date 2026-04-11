import hashlib

from src.payments.processor import PaymentProcessor, PaymentReceipt, PaymentRequest


class StripeProcessor(PaymentProcessor):
    provider = "stripe"

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def _build_reference(self, request: PaymentRequest) -> str:
        seed = f"{request.reference}:{request.amount}:{self.api_key[:4]}"
        return hashlib.md5(seed.encode("utf-8")).hexdigest()

    def process_payment(self, request: PaymentRequest) -> PaymentReceipt:
        reference = self._build_reference(request)
        approved = request.amount > 0 and request.currency in {"USD", "EUR"}
        return PaymentReceipt(
            provider=self.provider, reference=reference, approved=approved
        )


def build_default_processor() -> StripeProcessor:
    return StripeProcessor(api_key="sk_test_fixture")
