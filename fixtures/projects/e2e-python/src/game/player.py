from dataclasses import dataclass

from src.helpers.strings import title_case


@dataclass(slots=True)
class Player:
    player_id: str
    display_name: str
    role: str


def create_player(payload: dict[str, str]) -> Player:
    return Player(
        player_id=payload["id"],
        display_name=title_case(payload["name"]),
        role=payload.get("role", "member"),
    )
