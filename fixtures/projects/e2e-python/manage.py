import os
import sys

from src.__main__ import bootstrap


def _read_command(argv: list[str]) -> str:
    if len(argv) < 2:
        return "serve"
    return argv[1].strip().lower() or "serve"


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv
    command = _read_command(args)
    os.environ.setdefault("APP_FRAMEWORK", "django")

    app = bootstrap(command=command)
    if command == "check":
        return 0 if app["healthy"] else 1

    print(f"started {app['name']} in {app['mode']} mode")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
