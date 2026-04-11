extends Resource
class_name HealthResource

@export var max_health: int = 100
@export var current_health: int = 100
@export var regeneration_rate: float = 1.5

func restore(amount: int) -> void:
	current_health = min(current_health + amount, max_health)

func apply_penalty(amount: int) -> void:
	current_health = max(current_health - amount, 0)

func is_exhausted() -> bool:
	return current_health <= 0

func snapshot() -> Dictionary:
	return {
		"max_health": max_health,
		"current_health": current_health,
		"regeneration_rate": regeneration_rate,
	}
