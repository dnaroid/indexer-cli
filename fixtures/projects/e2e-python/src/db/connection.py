from dataclasses import dataclass
import sqlite3


@dataclass(slots=True)
class DatabaseConfig:
    path: str
    journal_mode: str = "wal"


def connect(config: DatabaseConfig) -> sqlite3.Connection:
    connection = sqlite3.connect(config.path)
    connection.execute(f"pragma journal_mode={config.journal_mode}")
    return connection


def ping(config: DatabaseConfig) -> bool:
    connection = connect(config)
    try:
        connection.execute("select 1")
        return True
    finally:
        connection.close()
