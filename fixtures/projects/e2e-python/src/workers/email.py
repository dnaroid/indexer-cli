import json

from src.logging.logger import AppLogger
from src.workers.notification import enqueue_notification


def _serialize_payload(payload: dict[str, str]) -> str:
    return json.dumps(payload, sort_keys=True)


def send_email(payload: dict[str, str], logger: AppLogger) -> dict[str, str | bool]:
    logger.info("sending email", recipient=payload["to"])
    if payload.get("priority") == "high":
        enqueue_notification(
            {
                "channel": "email",
                "recipient": payload["to"],
                "message": payload["subject"],
            },
            logger,
        )
    return {
        "message_id": f"email-{len(_serialize_payload(payload))}",
        "status": "sent",
        "delivered": True,
    }


def main() -> None:
    logger = AppLogger(debug=False)
    send_email(
        {
            "to": "ops@example.com",
            "subject": "worker started",
            "body": "email worker ready",
            "priority": "normal",
        },
        logger,
    )
