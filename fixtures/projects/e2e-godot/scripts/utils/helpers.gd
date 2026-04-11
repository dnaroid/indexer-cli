extends RefCounted
class_name Helpers

static func normalize_language(value: String) -> String:
	if value == "":
		return "en"
	return value.to_lower()
