from dataclasses import dataclass

from src.core.engine import EngineState, load_engine_state
from src.game.player import Player, create_player


@dataclass(slots=True)
class Scheduler:
    state: EngineState
    owner: Player


def build_scheduler(players: list[dict[str, str]]) -> Scheduler:
    state = load_engine_state(players)
    owner = create_player(state.players[0])
    return Scheduler(state=state, owner=owner)
