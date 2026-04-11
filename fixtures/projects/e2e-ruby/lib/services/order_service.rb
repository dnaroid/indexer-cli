require_relative "./user_service.rb"
require_relative "../payments/stripe_processor.rb"
require_relative "../utils/errors.rb"

module Services
  class OrderService
    def initialize(user_service = UserService.new, processor = Payments::StripeProcessor.new)
      @user_service = user_service
      @processor = processor
    end

    def validate_order(order)
      raise ValidationError, "amount must be positive" if order[:amount_cents].to_i <= 0
      raise ValidationError, "provider is required" if order[:provider].to_s.strip.empty?

      true
    end

    def create_order(user:, amount_cents:, provider: "stripe")
      validate_order(amount_cents: amount_cents, provider: provider)
      current_user = user.is_a?(Hash) && user.key?(:session_token) ? user : @user_service.create_user(user)
      payment = @processor.process_payment(amount_cents, source: provider)
      {
        reference: build_reference("ord"),
        user: current_user,
        payment: payment,
        status: "created",
      }
    end

    private

    def build_reference(prefix)
      "#{prefix}-#{Time.now.to_i}"
    end
  end
end
