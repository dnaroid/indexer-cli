extends RefCounted
class_name StateTypes

enum MatchState {
	IDLE,
	LOADING,
	ACTIVE,
	FINISHED,
}

static func is_terminal(state: MatchState) -> bool:
	return state == MatchState.FINISHED

static func default_state() -> MatchState:
	return MatchState.IDLE
