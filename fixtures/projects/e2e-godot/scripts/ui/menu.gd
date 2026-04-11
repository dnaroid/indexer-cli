extends Control
class_name MainMenu

const SaveManager = preload("../db/save_manager.gd")

@export var profile_name: String = "Hero"

var save_manager := SaveManager.new()
var last_path := ""

func _ready() -> void:
	last_path = save_manager.resolve_save_path(profile_name)

func open_profile() -> String:
	return last_path
