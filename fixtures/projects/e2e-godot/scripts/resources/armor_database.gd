extends Resource
class_name ArmorDatabase

const WeaponDatabase = preload("../resources/weapon_database.gd")

var weapon_database := WeaponDatabase.new()

func prime() -> void:
	weapon_database.warmup()
