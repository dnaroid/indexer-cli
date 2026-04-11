require "json"
require "sinatra/base"
require_relative "../lib/api/v1/handler.rb"
require_relative "../lib/services/user_service.rb"
require_relative "../lib/services/order_service.rb"

module E2ERuby
  class CLI < Sinatra::Base
    def self.call(env = nil)
      request = env || default_request
      Api::V1::Handler.new.handle_request(request)
    end

    def self.default_request
      {
        path: "/users",
        method: "GET",
        params: { "id" => "guest-1", "email" => "demo@example.com", "name" => "Demo User" },
      }
    end

    def self.seed!
      user = Services::UserService.new.create_user(default_request[:params])
      Services::OrderService.new.create_order(
        user: user,
        amount_cents: 2500,
        provider: "stripe",
      )
    end
  end
end
