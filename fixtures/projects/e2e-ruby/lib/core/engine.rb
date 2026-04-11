require_relative "../config/settings.rb"
require_relative "../utils/helpers.rb"
require_relative "../services/auth.rb"

module Core
  class Engine
    def initialize(settings = Config::Settings.new, auth = Services::Auth.new)
      @settings = settings
      @auth = auth
    end

    def boot(user_id:, name:)
      {
        endpoint: @settings.endpoint,
        user: @auth.authenticate(user_id),
        name: Helpers.normalize_name(name),
      }
    end
  end
end
