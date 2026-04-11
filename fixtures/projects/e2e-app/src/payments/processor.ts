export type PaymentRequest = {
	amount: number;
	currency: string;
	reference: string;
	metadata: Record<string, string>;
};

export type PaymentReceipt = {
	id: string;
	provider: string;
	approved: boolean;
	amount: number;
	currency: string;
};

export interface PaymentProcessor {
	readonly provider: string;
	processPayment(request: PaymentRequest): Promise<PaymentReceipt>;
	refundPayment(receipt: PaymentReceipt): Promise<boolean>;
}

export abstract class PaymentProcessor {
	abstract readonly provider: string;

	protected normalizeAmount(amount: number): number {
		return validateInput(amount);
	}

	abstract processPayment(request: PaymentRequest): Promise<PaymentReceipt>;
	abstract refundPayment(receipt: PaymentReceipt): Promise<boolean>;
}

export function validateInput(amount: number): number {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error("Payment amount must be a positive number");
	}
	return Math.round(amount * 100) / 100;
}