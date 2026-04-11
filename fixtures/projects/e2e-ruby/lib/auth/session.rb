require "securerandom"
require "time"
require_relative "../utils/errors.rb"

module Auth
  class Session
    TOKEN_PREFIX = "auth".freeze

	  def create_session(user_id, metadata = {})
	    raise ValidationError, "user_id is required" if user_id.to_s.strip.empty?

	    token = "#{TOKEN_PREFIX}-#{SecureRandom.hex(6)}"
	    {
        user_id: user_id,
        token: token,
        metadata: metadata,
	      issued_at: Time.now.utc.iso8601,
	    }
	  end

	  def login_access(user_id)
	    create_session(user_id, access: "login")
	  end

	  def validate_token(token)
	    raise ValidationError, "token is invalid" if invalid_token?(token)

      token.start_with?(TOKEN_PREFIX)
    end

    private

    def invalid_token?(token)
      token.to_s.strip.empty? || !token.include?("-")
    end
  end
end
