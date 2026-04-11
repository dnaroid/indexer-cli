require_relative "../constants/http_constants.rb"
require_relative "../helpers/string_helper.rb"

module Middleware
  class AuthMiddleware
    def initialize(app)
      @app = app
    end

    def call(env)
      token = env[HttpConstants::AUTHORIZATION_HEADER]
      return unauthorized unless token.to_s.start_with?("Bearer ")

      env["normalized_user"] = StringHelper.slugify(env["REMOTE_USER"] || "guest")
      @app.call(env)
    end

    private

    def unauthorized
      [HttpConstants::UNAUTHORIZED, {}, ["unauthorized"]]
    end
  end
end
