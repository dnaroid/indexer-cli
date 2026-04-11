extends RefCounted
class_name ConfigLoader

const GameConstants = preload("../constants/game_constants.gd")

func load_defaults() -> Dictionary:
	return {
		"volume": GameConstants.DEFAULT_VOLUME,
		"language": GameConstants.DEFAULT_LANGUAGE,
		"slot": GameConstants.build_slot_name(1),
	}

func merge_config(base: Dictionary, overrides: Dictionary) -> Dictionary:
	var merged := base.duplicate()
	for key in overrides.keys():
		merged[key] = overrides[key]
	return merged
