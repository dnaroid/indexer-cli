import type { PaymentProcessor, PaymentReceipt, PaymentRequest } from "../payments/processor";
import type { User } from "./user";
import { NotFoundError, ValidationError } from "../utils/errors";
import type { Logger } from "../utils/logger";

export type OrderItem = {
	sku: string;
	quantity: number;
	price: number;
};

export type OrderInput = {
	userId: string;
	items: OrderItem[];
	currency: string;
	notes?: string;
};

export type Order = {
	id: string;
	userId: string;
	amount: number;
	currency: string;
	status: "pending" | "paid";
	receipt: PaymentReceipt;
};

export function validateOrder(input: OrderInput): OrderInput {
	if (!input.userId.trim()) {
		throw new ValidationError("Orders require a user id", { field: "userId" });
	}
	if (input.items.length === 0) {
		throw new ValidationError("Orders require at least one item", { field: "items" });
	}
	for (const item of input.items) {
		if (!item.sku.trim() || item.quantity <= 0 || item.price <= 0) {
			throw new ValidationError("Each order item must include a sku, quantity, and positive price", { sku: item.sku });
		}
	}
	if (input.currency !== "USD" && input.currency !== "EUR") {
		throw new ValidationError("Unsupported order currency", { currency: input.currency });
	}
	return input;
}

export async function createOrder(
	input: OrderInput,
	user: User | undefined,
	processor: PaymentProcessor,
	logger: Logger,
): Promise<Order> {
	const normalized = validateOrder(input);
	if (!user || user.id !== normalized.userId) {
		throw new NotFoundError("User not found for order", normalized.userId);
	}

	const amount = normalized.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
	const paymentRequest: PaymentRequest = {
		amount,
		currency: normalized.currency,
		reference: `${user.id}-${normalized.items.length}`,
		metadata: { customerEmail: user.email, note: normalized.notes ?? "" },
	};
	const receipt = await processor.processPayment(paymentRequest);

	logger.info("Order payment completed", {
		provider: processor.provider,
		userId: user.id,
		amount: amount.toFixed(2),
	});

	return {
		id: `order-${user.id}-${normalized.items.length}`,
		userId: user.id,
		amount,
		currency: normalized.currency,
		status: "paid",
		receipt,
	};
}