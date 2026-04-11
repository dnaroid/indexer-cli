extends RefCounted
class_name GameEngine

const GameManager = preload("../game/game_manager.gd")
const Helpers = preload("../utils/helpers.gd")
const GameConstants = preload("../constants/game_constants.gd")

var game_manager := GameManager.new()
var language := GameConstants.DEFAULT_LANGUAGE

func boot() -> void:
	language = Helpers.normalize_language(language)
	game_manager.boot_campaign()
