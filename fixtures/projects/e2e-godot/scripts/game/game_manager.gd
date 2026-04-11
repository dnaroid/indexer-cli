extends Node
class_name GameManager

const CombatManager = preload("../combat/combat_manager.gd")
const HealthResource = preload("../resources/health_resource.gd")
const Session = preload("../multiplayer/session.gd")
const AudioManager = preload("../singletons/audio_manager.gd")

@export var auto_start_combat: bool = true

var combat_manager: CombatManager
var multiplayer_session: Session
var party_health := HealthResource.new()

func _ready() -> void:
	combat_manager = CombatManager.new()
	multiplayer_session = Session.new()
	add_child(combat_manager)
	add_child(multiplayer_session)
	combat_manager.attach_session(multiplayer_session)
	AudioManager.new().play_music("battle_theme")
	if auto_start_combat:
		boot_campaign()

func boot_campaign() -> void:
	party_health.max_health = 120
	party_health.current_health = 120
	combat_manager.begin_combat(party_health)

func tick(delta: float) -> void:
	combat_manager._process(delta)

func get_combat_manager() -> CombatManager:
	return combat_manager
