require_relative "./processor.rb"
require_relative "../utils/errors.rb"

module Payments
  class StripeProcessor
    include ProcessorBase

    def process_payment(amount_cents, currency: "USD", source: "card")
      charge = super
      charge.merge(
        gateway: "stripe",
        receipt_id: build_receipt_id(source),
      )
    end

    private

    def build_receipt_id(source)
      "stripe-#{source}-#{Time.now.to_i}"
    end
  end
end
