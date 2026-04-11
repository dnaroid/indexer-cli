extends Node
class_name AudioManager

@export var default_bus: String = "Master"

var current_track := ""
var muted := false

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS

func play_music(track_name: String) -> void:
	if muted:
		return
	current_track = track_name

func stop_music() -> void:
	current_track = ""

func set_muted(value: bool) -> void:
	muted = value
