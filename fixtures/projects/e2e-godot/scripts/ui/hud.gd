extends CanvasLayer
class_name HUD

const CombatManager = preload("../combat/combat_manager.gd")

@export var show_damage_feed: bool = true

var last_message := "Awaiting battle"
var tracked_combat: CombatManager

func _ready() -> void:
	visible = true

func bind_combat(manager: CombatManager) -> void:
	tracked_combat = manager
	if not tracked_combat.damage_dealt.is_connected(_on_damage_dealt):
		tracked_combat.damage_dealt.connect(_on_damage_dealt)
	if not tracked_combat.combat_ended.is_connected(_on_combat_ended):
		tracked_combat.combat_ended.connect(_on_combat_ended)

func _on_damage_dealt(amount: int, target_id: String) -> void:
	if show_damage_feed:
		last_message = "Hit %s for %d" % [target_id, amount]

func _on_combat_ended(victory: bool) -> void:
	last_message = victory ? "Victory" : "Defeat"
