import { loadConfig } from "./config";
import type { AppConfig } from "./config";
import { validateToken } from "./auth/session";
import { createOrder } from "./services/order";
import { UserService } from "./services/user";
import { Logger } from "./utils/logger";
import { AppError } from "./utils/errors";
import { formatDate } from "./utils/format";
import { StripeProcessor } from "./payments/stripe";
import { PaypalProcessor } from "./payments/paypal";

export async function bootstrapApp(env: NodeJS.ProcessEnv = process.env): Promise<{ config: AppConfig; startedAt: string }> {
	const config = loadConfig(env);
	const logger = new Logger(config.logLevel);
	const userService = new UserService(logger);
	const paymentProcessor =
		config.paymentProvider === "paypal" ? new PaypalProcessor() : new StripeProcessor();

	const registration = userService.register({
		name: "Ava Carter",
		email: "ava@example.com",
		password: "secret-pass-123",
		roles: ["admin", "buyer"],
	});

	if (!validateToken(registration.session.token)) {
		throw new AppError("Session token failed verification", "BOOTSTRAP_SESSION");
	}

	const order = await createOrder(
		{
			userId: registration.user.id,
			items: [{ sku: "keyboard", quantity: 1, price: 129.99 }],
			currency: "USD",
			notes: "Ship before Friday",
		},
		registration.user,
		paymentProcessor,
		logger,
	);

	logger.info("Application bootstrap complete", {
		userId: registration.user.id,
		orderId: order.id,
		startedAt: formatDate(new Date()),
		port: String(config.port),
	});

	return { config, startedAt: formatDate(new Date()) };
}

export async function main(): Promise<void> {
	await bootstrapApp();
}

main().catch((error: unknown) => {
	const message = error instanceof AppError ? error.message : String(error);
	console.error(message);
	process.exit(1);
});