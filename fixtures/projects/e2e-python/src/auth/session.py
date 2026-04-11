from dataclasses import dataclass, field
import hashlib
import time


@dataclass(slots=True)
class Session:
    user_id: str
    email: str
    token: str
    roles: list[str] = field(default_factory=list)
    expires_at: int = 0


def _build_payload(user_id: str, email: str, expires_at: int) -> str:
    return f"{user_id}:{email.lower()}:{expires_at}"


def create_session(user_id: str, email: str, roles: list[str]) -> Session:
    expires_at = int(time.time()) + 60 * 60 * 8
    payload = _build_payload(user_id, email, expires_at)
    token = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return Session(
        user_id=user_id,
        email=email,
        token=token,
        roles=list(roles),
        expires_at=expires_at,
    )


def create_access_session(user_id: str, email: str, roles: list[str]) -> Session:
    return create_session(user_id=user_id, email=email, roles=roles)


def login_user(user_id: str, email: str, roles: list[str]) -> Session:
    return create_access_session(user_id=user_id, email=email, roles=roles)


def read_access_token(session: Session) -> str:
    return session.token


def validate_token(token: str) -> bool:
    if len(token) < 32:
        return False
    return all(character in "0123456789abcdef" for character in token.lower())
