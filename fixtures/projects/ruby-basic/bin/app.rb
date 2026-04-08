require_relative "../lib/app"

module RubyBasic
  class CLI
    def self.call
      App.new.render
    end
  end
end
