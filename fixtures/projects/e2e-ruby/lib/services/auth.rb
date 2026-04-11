require_relative "../auth/session.rb"
require_relative "../utils/helpers.rb"

module Services
  class Auth
    def initialize(session_store = ::Auth::Session.new)
      @session_store = session_store
    end

    def authenticate(user_id)
      normalized_user_id = Helpers.normalize_name(user_id)
      @session_store.create_session(normalized_user_id)
    end
  end
end
