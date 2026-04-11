require "json"
require_relative "../../services/user_service.rb"
require_relative "../../helpers/pagination_helper.rb"

module Api
  module V1
    class Handler
      def handle_request(request)
        user = Services::UserService.new.create_user(request.fetch(:params))
        JSON.generate(
          version: "v1",
          method: normalize_method(request),
          data: user,
          pagination: PaginationHelper.window(page: 1, per_page: 10),
        )
      end

      private

      def normalize_method(request)
        request[:method].to_s.downcase
      end
    end
  end
end
