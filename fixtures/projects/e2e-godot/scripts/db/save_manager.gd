extends RefCounted
class_name SaveManager

const ConfigLoader = preload("config_loader.gd")
const StringUtils = preload("../helpers/string_utils.gd")

var loader := ConfigLoader.new()

func build_save_payload(profile_name: String, progress: Dictionary) -> Dictionary:
	var defaults := loader.load_defaults()
	defaults["profile"] = StringUtils.slugify(profile_name)
	defaults["progress"] = progress
	return defaults

func resolve_save_path(profile_name: String) -> String:
	return "user://%s.save" % StringUtils.slugify(profile_name)
