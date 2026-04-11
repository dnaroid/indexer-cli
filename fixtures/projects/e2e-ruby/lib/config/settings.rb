require "uri"
require_relative "../utils/helpers.rb"

module Config
  class Settings
    def initialize(env = {})
      @env = env
    end

    def endpoint
      Helpers.normalize_url(@env[:endpoint] || @env["endpoint"] || "https://example.test/internal")
    end
  end
end
