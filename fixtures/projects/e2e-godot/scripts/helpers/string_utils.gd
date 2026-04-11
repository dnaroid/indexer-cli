extends RefCounted
class_name StringUtils

static func slugify(value: String) -> String:
	return value.to_lower().replace(" ", "-")

static func truncate_label(value: String, max_length: int) -> String:
	if value.length() <= max_length:
		return value
	return value.substr(0, max_length) + "..."

static func build_locale_key(section: String, key: String) -> String:
	return "%s.%s" % [slugify(section), slugify(key)]
