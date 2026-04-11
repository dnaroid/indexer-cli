extends Node
class_name Session

signal connection_changed(connected: bool)

const CombatManager = preload("../combat/combat_manager.gd")

@export var retry_limit: int = 2

var lobby_id := ""
var connected := false
var retries := 0
var observed_combat: CombatManager

func _ready() -> void:
	retries = 0

func connect_to_lobby(next_lobby_id: String) -> void:
	lobby_id = next_lobby_id
	connected = true
	connection_changed.emit(connected)

func disconnect_from_lobby() -> void:
	connected = false
	connection_changed.emit(connected)

func is_connected_to_peer() -> bool:
	return connected

func watch_combat(manager: CombatManager) -> void:
	observed_combat = manager
	if not observed_combat.damage_dealt.is_connected(_on_damage_dealt):
		observed_combat.damage_dealt.connect(_on_damage_dealt)

func _on_damage_dealt(amount: int, target_id: String) -> void:
	if amount > 0 and target_id != "":
		retries = min(retries + 1, retry_limit)
