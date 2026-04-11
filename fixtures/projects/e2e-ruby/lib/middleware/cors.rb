require_relative "./auth.rb"
require_relative "../core/engine.rb"

module Middleware
  class Cors
    def initialize(app)
      @app = app
    end

    def call(env)
      Auth.new.call(env)
      Core::Engine.new.boot(user_id: env["user_id"] || "guest", name: env["name"] || "Guest")
      @app.call(env)
    end
  end
end
