extends Node
class_name SceneLoader

const GameEngine = preload("../core/game_engine.gd")

var game_engine := GameEngine.new()

func _ready() -> void:
	game_engine.boot()
