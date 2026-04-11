require_relative "../services/auth.rb"

module Middleware
  class Auth
    def call(env)
      Services::Auth.new.authenticate(env["user_id"] || "guest")
      env
    end
  end
end
