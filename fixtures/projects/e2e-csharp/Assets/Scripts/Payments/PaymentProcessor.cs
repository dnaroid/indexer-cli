using MyApp.Types;

namespace MyApp.Payments
{
    public abstract class PaymentProcessor
    {
        public string ProviderName { get; protected set; }

        protected PaymentProcessor(string providerName)
        {
            ProviderName = providerName;
        }

        public abstract ApiResponse ProcessPayment(string orderId, int amountCents);

        public virtual bool CanProcess(int amountCents)
        {
            return amountCents > 0;
        }
    }
}
