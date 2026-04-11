extends RefCounted
class_name GameConstants

const DEFAULT_VOLUME := 0.8
const SAVE_SLOT_PREFIX := "slot_"
const MAX_PROFILE_COUNT := 3
const DEFAULT_LANGUAGE := "en"

static func build_slot_name(index: int) -> String:
	return "%s%d" % [SAVE_SLOT_PREFIX, index]

static func supported_languages() -> PackedStringArray:
	return ["en", "es", "ja"]
