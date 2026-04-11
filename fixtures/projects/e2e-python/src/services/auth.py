def issue_identity(email: str, roles: list[str]) -> object:
    from src.auth.session import create_session
    from src.utils.errors import ValidationError

    normalized = email.strip().lower()
    if "@" not in normalized:
        raise ValidationError("account requires a valid email", field="email")
    return create_session(user_id=normalized, email=normalized, roles=roles)
