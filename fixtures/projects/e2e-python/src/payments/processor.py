from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Protocol


class PaymentAuditHook(Protocol):
    def record(self, provider: str, reference: str) -> None: ...


@dataclass(slots=True)
class PaymentRequest:
    amount: float
    currency: str
    reference: str


@dataclass(slots=True)
class PaymentReceipt:
    provider: str
    reference: str
    approved: bool


class PaymentProcessor(ABC):
    provider: str

    @abstractmethod
    def process_payment(self, request: PaymentRequest) -> PaymentReceipt:
        raise NotImplementedError


def process_payment(
    processor: PaymentProcessor,
    request: PaymentRequest,
    audit: PaymentAuditHook | None = None,
) -> PaymentReceipt:
    receipt = processor.process_payment(request)
    if audit is not None:
        audit.record(receipt.provider, receipt.reference)
    return receipt
