import { PaymentProcessor, type PaymentReceipt, type PaymentRequest } from "./processor";

export class PaypalProcessor extends PaymentProcessor {
	readonly provider = "paypal";

	async processPayment(request: PaymentRequest): Promise<PaymentReceipt> {
		const amount = this.normalizeAmount(request.amount);
		const approved = request.reference.length >= 3;
		return {
			id: `paypal-${request.reference}`,
			provider: this.provider,
			approved,
			amount,
			currency: request.currency,
		};
	}

	async refundPayment(receipt: PaymentReceipt): Promise<boolean> {
		return receipt.provider === this.provider && receipt.amount > 0;
	}
}