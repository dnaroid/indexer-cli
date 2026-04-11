from dataclasses import dataclass
import re

from src.auth.session import Session, create_session
from src.utils.errors import ValidationError


@dataclass(slots=True)
class UserValidator:
    class Policy:
        minimum_password_length = 12

    def validate_user(self, payload: dict[str, str]) -> dict[str, str]:
        email = payload.get("email", "").strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise ValidationError("users require a valid email", field="email")
        password = payload.get("password", "")
        if len(password) < self.Policy.minimum_password_length:
            raise ValidationError("users require a stronger password", field="password")
        name = payload.get("name", "").strip()
        if not name:
            raise ValidationError("users require a display name", field="name")
        return {"email": email, "password": password, "name": name}


def validate_user(payload: dict[str, str]) -> dict[str, str]:
    return UserValidator().validate_user(payload)


def create_user(payload: dict[str, str]) -> dict[str, str | Session]:
    normalized = validate_user(payload)
    session = create_session(
        user_id=normalized["email"], email=normalized["email"], roles=["buyer"]
    )
    return {
        "id": normalized["email"],
        "email": normalized["email"],
        "name": normalized["name"],
        "session": session,
    }
