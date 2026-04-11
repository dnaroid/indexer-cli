extends RefCounted
class_name Log

@export var channel: String = "game"

var history: PackedStringArray = []

func info(message: String, context: Dictionary = {}) -> String:
	var entry := _format("INFO", message, context)
	history.append(entry)
	return entry

func warning(message: String, context: Dictionary = {}) -> String:
	var entry := _format("WARN", message, context)
	history.append(entry)
	return entry

func _format(level: String, message: String, context: Dictionary) -> String:
	return "[%s][%s] %s %s" % [channel, level, message, JSON.stringify(context)]
