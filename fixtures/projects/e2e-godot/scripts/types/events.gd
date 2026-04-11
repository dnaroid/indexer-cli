extends RefCounted
class_name EventTypes

const EVENT_READY := "ready"
const EVENT_CONNECTED := "connected"
const EVENT_SAVED := "saved"

static func all_events() -> PackedStringArray:
	return [EVENT_READY, EVENT_CONNECTED, EVENT_SAVED]

static func has_event(event_name: String) -> bool:
	return event_name in all_events()
