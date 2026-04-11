require "json"
require_relative "../../services/order_service.rb"
require_relative "../../helpers/pagination_helper.rb"

module Api
  module V2
    class Handler
      def handle_request(request)
        order = Services::OrderService.new.create_order(
          user: request.fetch(:params),
          amount_cents: request[:amount_cents] || 1500,
          provider: request[:provider] || "stripe",
        )
        JSON.generate(
          version: "v2",
          method: request_method(request),
          order: order,
          page: PaginationHelper.offset(page: 1, per_page: 10),
        )
      end

      private

      def request_method(request)
        request[:method].to_s.upcase
      end
    end
  end
end
