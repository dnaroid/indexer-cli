from src.logging.logger import AppLogger
from src.workers.email import send_email


def enqueue_notification(
    payload: dict[str, str], logger: AppLogger
) -> dict[str, str | bool]:
    logger.info("queueing notification", channel=payload["channel"])
    if payload["channel"] == "email":
        send_email(
            {
                "to": payload["recipient"],
                "subject": "notification",
                "body": payload["message"],
                "priority": "normal",
            },
            logger,
        )
    return {"notification_id": f"notif-{payload['channel']}", "queued": True}


def format_notification(result: dict[str, str | bool]) -> str:
    state = "queued" if result.get("queued") else "failed"
    return f"notification {result['notification_id']} is {state}"
