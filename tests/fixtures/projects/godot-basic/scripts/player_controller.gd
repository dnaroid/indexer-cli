class_name PlayerController
extends CharacterBody2D

signal health_changed(new_value: int)

var game_mgr = preload("res://scripts/game_manager.gd")

func _ready():
    pass

func _physics_process(delta):
    pass

func apply_damage(amount: int):
    pass
