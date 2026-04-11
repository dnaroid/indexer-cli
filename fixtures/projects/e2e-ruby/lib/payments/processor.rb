require "json"
require_relative "../utils/errors.rb"

module Payments
  module ProcessorBase
    def process_payment(amount_cents, currency: "USD", source: "card")
      raise ValidationError, "amount must be positive" if amount_cents.to_i <= 0

      {
        provider: provider_name,
        amount_cents: amount_cents,
        currency: currency,
        source: source,
        metadata: serialize_payload(amount_cents, currency, source),
      }
    end

    def provider_name
      self.class.name.split("::").last.sub("Processor", "").downcase
    end

    private

    def serialize_payload(amount_cents, currency, source)
      JSON.generate(amount_cents: amount_cents, currency: currency, source: source)
    end
  end
end
