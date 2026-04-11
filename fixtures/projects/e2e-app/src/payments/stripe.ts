import { PaymentProcessor, type PaymentReceipt, type PaymentRequest } from "./processor";

export class StripeProcessor extends PaymentProcessor {
	readonly provider = "stripe";

	async processPayment(request: PaymentRequest): Promise<PaymentReceipt> {
		const amount = this.normalizeAmount(request.amount);
		const approved = request.currency === "USD" || request.currency === "EUR";
		return {
			id: `stripe-${request.reference}`,
			provider: this.provider,
			approved,
			amount,
			currency: request.currency,
		};
	}

	async refundPayment(receipt: PaymentReceipt): Promise<boolean> {
		return receipt.provider === this.provider && receipt.approved;
	}
}