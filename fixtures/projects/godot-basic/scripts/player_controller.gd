extends CharacterBody2D
class_name PlayerController

signal health_changed

const GameManager = preload("res://scripts/game_manager.gd")

@export var speed: float = 220.0
var health: int = 100

func _ready() -> void:
	health_changed.emit()

func _physics_process(delta: float) -> void:
	var movement := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = movement * speed
	move_and_slide()

func apply_damage(amount: int) -> void:
	health = max(health - amount, 0)
	health_changed.emit()
