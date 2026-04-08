import os
from services.calculator import Calculator, add


class App:
    def run(self):
        print("running")


def bootstrap():
    app = App()
    app.run()
