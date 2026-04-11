require "json"
require_relative "./engine.rb"

module Core
  class HealthCheck
    def call
      JSON.generate(status: "ok", engine: Engine.name)
    end
  end
end
