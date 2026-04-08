require "json"
require_relative "services/calculator"

module RubyBasic
  class App
    include Services::Formatter

    def run
      Services::Calculator.new.add(2, 3)
    end

    def render
      JSON.generate(message: format_total(run))
    end
  end
end
