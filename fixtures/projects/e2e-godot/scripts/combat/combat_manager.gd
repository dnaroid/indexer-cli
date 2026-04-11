extends Node
class_name CombatManager

signal damage_dealt(amount: int, target_id: String)
signal combat_ended(victory: bool)

const Session = preload("../multiplayer/session.gd")
const HealthResource = preload("../resources/health_resource.gd")

@export var tick_rate: float = 0.2

var active_session: Session
var active_health: HealthResource
var elapsed := 0.0

func _ready() -> void:
	elapsed = 0.0

func _process(delta: float) -> void:
	if active_session == null or active_health == null:
		return
	elapsed += delta
	if elapsed >= tick_rate and active_session.is_connected_to_peer():
		elapsed = 0.0
		deal_damage(5, "enemy_boss")

func attach_session(session: Session) -> void:
	active_session = session
	active_session.watch_combat(self)

func begin_combat(health: HealthResource) -> void:
	active_health = health
	if active_session != null:
		active_session.connect_to_lobby("arena-01")

func deal_damage(amount: int, target_id: String) -> void:
	if active_health == null:
		return
	active_health.current_health = max(active_health.current_health - amount, 0)
	damage_dealt.emit(amount, target_id)
	if active_health.current_health == 0:
		combat_ended.emit(false)
