require_relative "../constants/app_constants.rb"
require_relative "../constants/http_constants.rb"

module Middleware
  class CorsMiddleware
    def initialize(app)
      @app = app
    end

    def call(env)
      status, headers, body = @app.call(env)
      headers = headers.merge(
        HttpConstants::ACCESS_CONTROL_ALLOW_ORIGIN => AppConstants::DEFAULT_ORIGIN,
        HttpConstants::ACCESS_CONTROL_ALLOW_HEADERS => "content-type, authorization",
      )
      [status, headers, body]
    end

    private

    def middleware_name
      "cors"
    end
  end
end
