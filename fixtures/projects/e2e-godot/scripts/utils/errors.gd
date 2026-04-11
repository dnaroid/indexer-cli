extends RefCounted
class_name ErrorCatalog

const Log = preload("logger.gd")

var logger := Log.new()

class SessionError:
	var code := "session_error"
	var message := "Session failed"

class CombatError:
	var code := "combat_error"
	var message := "Combat failed"

func build_error(domain: String, detail: String) -> Dictionary:
	var error_type := SessionError.new() if domain == "multiplayer" else CombatError.new()
	logger.warning("error_created", {"domain": domain, "detail": detail})
	return {"code": error_type.code, "message": detail}
