from services.calculator import Calculator, add
import os


class App:
    def run(self) -> int:
        calc = Calculator()
        return add(calc.base, 2)


def bootstrap() -> int:
    app = App()
    return app.run()


if __name__ == "__main__":
    print(bootstrap())
