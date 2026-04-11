extends Node
class_name InputHandler

@export var movement_action: String = "move"

var last_vector := Vector2.ZERO

func _input(event: InputEvent) -> void:
	if event.is_action_pressed(movement_action):
		last_vector = Vector2.RIGHT

func clear_state() -> void:
	last_vector = Vector2.ZERO

func has_input() -> bool:
	return last_vector != Vector2.ZERO
