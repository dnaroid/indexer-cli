from dataclasses import dataclass

from src.config.settings import Settings, load_settings
from src.utils.helpers import build_engine_id, select_page


@dataclass(slots=True)
class EngineState:
    engine_id: str
    settings: Settings
    players: list[dict[str, str]]


def load_engine_state(players: list[dict[str, str]]) -> EngineState:
    settings = load_settings()
    page = select_page(players, page=1)
    return EngineState(
        engine_id=build_engine_id(settings.app_name, settings.environment),
        settings=settings,
        players=page.items,
    )


def build_engine(players: list[dict[str, str]]) -> dict[str, object]:
    state = load_engine_state(players)
    return {
        "engine_id": state.engine_id,
        "environment": state.settings.environment,
        "players": state.players,
    }
