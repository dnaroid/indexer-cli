require_relative "../auth/session.rb"
require_relative "../utils/errors.rb"

module Services
  class UserService
    def initialize(session_store = Auth::Session.new)
      @session_store = session_store
    end

    def validate_user(payload)
      email = normalize_email(payload[:email] || payload["email"])
      raise ValidationError, "email must include @" unless email.include?("@")

      true
    end

    def create_user(payload)
      validate_user(payload)
      name = build_name(payload)
      session = @session_store.create_session(payload[:id] || payload["id"] || "guest")
      {
        id: payload[:id] || payload["id"] || "guest",
        email: normalize_email(payload[:email] || payload["email"]),
        name: name,
        session_token: session[:token],
      }
    end

    private

    def normalize_email(value)
      value.to_s.strip.downcase
    end

    def build_name(payload)
      payload[:name] || payload["name"] || "Anonymous"
    end
  end
end
