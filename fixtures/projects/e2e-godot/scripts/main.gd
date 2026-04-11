extends Node

const GameManager = preload("game/game_manager.gd")
const HUD = preload("ui/hud.gd")

var game_manager: GameManager
var hud_layer: HUD

func _ready() -> void:
	game_manager = GameManager.new()
	hud_layer = HUD.new()
	add_child(game_manager)
	add_child(hud_layer)
	game_manager.boot_campaign()
	hud_layer.bind_combat(game_manager.get_combat_manager())

func _process(delta: float) -> void:
	if game_manager != null:
		game_manager.tick(delta)
