using MyApp.Types;

namespace MyApp.Payments
{
    public class StripeProcessor : PaymentProcessor
    {
        public StripeProcessor() : base("stripe")
        {
        }

        public override ApiResponse ProcessPayment(string orderId, int amountCents)
        {
            if (!CanProcess(amountCents))
            {
                return new ApiResponse(false, "invalid_amount", 422);
            }

            var receipt = $"stripe:{orderId}:{amountCents}";
            return new ApiResponse(true, receipt, 200);
        }

        public string BuildCheckoutToken(string orderId)
        {
            return $"checkout_{orderId}_{ProviderName}";
        }
    }
}
