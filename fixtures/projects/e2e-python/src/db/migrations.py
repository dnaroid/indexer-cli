from dataclasses import dataclass

from src.db.connection import DatabaseConfig, connect


@dataclass(slots=True)
class Migration:
    name: str
    sql: str


def list_migrations() -> list[Migration]:
    return [
        Migration(
            name="001_users",
            sql="create table if not exists users (id text primary key, email text not null)",
        ),
        Migration(
            name="002_orders",
            sql="create table if not exists orders (id text primary key, user_id text not null)",
        ),
    ]


def run_migrations(config: DatabaseConfig) -> int:
    connection = connect(config)
    try:
        for migration in list_migrations():
            connection.execute(migration.sql)
        connection.commit()
        return len(list_migrations())
    finally:
        connection.close()
