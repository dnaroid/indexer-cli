class Session:
    def __init__(self, match_id: str, players: list[str]) -> None:
        self.match_id = match_id
        self.players = players
        self.round_scores: list[int] = []
        self.active = False

    def start_match(self) -> dict[str, int | str]:
        if len(self.players) < 2:
            raise ValueError("a game session needs at least two players")
        self.active = True
        self.round_scores.clear()
        return {"match_id": self.match_id, "player_count": len(self.players)}

    def end_round(self, score: int) -> dict[str, int]:
        if not self.active:
            raise RuntimeError("cannot end a round before the match starts")
        self.round_scores.append(score)
        return {"round": len(self.round_scores), "total_score": sum(self.round_scores)}

    def finish_match(self) -> dict[str, int | str]:
        winner_index = len(self.round_scores) % len(self.players)
        self.active = False
        return {
            "winner": self.players[winner_index],
            "rounds_played": len(self.round_scores),
        }


def open_match(match_id: str, players: list[str]) -> Session:
    session = Session(match_id=match_id, players=players)
    session.start_match()
    return session
