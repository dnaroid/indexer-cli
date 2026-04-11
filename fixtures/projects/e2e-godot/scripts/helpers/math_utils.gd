extends RefCounted
class_name MathUtils

static func clamp_percent(value: float) -> float:
	return clamp(value, 0.0, 1.0)

static func average(values: Array[float]) -> float:
	if values.is_empty():
		return 0.0
	var total := 0.0
	for value in values:
		total += value
	return total / values.size()

static func normalize_pair(x: float, y: float) -> Vector2:
	return Vector2(clamp_percent(x), clamp_percent(y))
