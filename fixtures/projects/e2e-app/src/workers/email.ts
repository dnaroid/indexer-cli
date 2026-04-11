import type { Logger } from "../utils/logger";
import { format } from "../utils/format";
import { enqueueNotification } from "./notification";

export type EmailPayload = {
	to: string;
	subject: string;
	body: string;
	priority: "low" | "normal" | "high";
};

export type EmailResult = {
	messageId: string;
	queuedAt: string;
	status: "sent" | "queued" | "failed";
};

let emailCounter = 0;

export async function sendEmail(payload: EmailPayload, logger: Logger): Promise<EmailResult> {
	const messageId = `email-${++emailCounter}`;
	logger.info("Sending email", { messageId, to: payload.to });

	if (payload.priority === "high") {
		await enqueueNotification({ channel: "email", recipient: payload.to, message: payload.subject }, logger);
	}

	return {
		messageId,
		queuedAt: format(new Date()),
		status: payload.to.includes("@") ? "sent" : "failed",
	};
}

export function main(): void {
	const logger = { info: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
	const payload: EmailPayload = { to: "admin@example.com", subject: "Worker started", body: "Email worker is running", priority: "normal" };
	sendEmail(payload, logger).catch(() => {});
}