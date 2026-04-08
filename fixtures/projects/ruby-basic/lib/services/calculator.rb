module Services
  module Formatter
    def format_total(value)
      "Total: #{value}"
    end
  end

  class Calculator
    extend Formatter

    def add(left, right)
      left + right
    end

    def self.multiply(left, right)
      left * right
    end
  end
end
