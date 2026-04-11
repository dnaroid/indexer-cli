extends Resource
class_name WeaponDatabase

const GameConstants = preload("../constants/game_constants.gd")
const GameEngine = preload("../core/game_engine.gd")

@export var slots: int = GameConstants.MAX_PROFILE_COUNT
var engine := GameEngine.new()

func warmup() -> void:
	engine.boot()
