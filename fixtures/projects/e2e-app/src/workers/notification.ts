import type { Logger } from "../utils/logger";
import { sendEmail } from "./email";

export type NotificationPayload = {
	channel: "email" | "sms" | "push";
	recipient: string;
	message: string;
};

export type NotificationResult = {
	notificationId: string;
	delivered: boolean;
};

let notificationCounter = 0;

export async function enqueueNotification(payload: NotificationPayload, logger: Logger): Promise<NotificationResult> {
	const notificationId = `notif-${++notificationCounter}`;
	logger.info("Enqueuing notification", { notificationId, channel: payload.channel });

	if (payload.channel === "email") {
		await sendEmail({ to: payload.recipient, subject: "Notification", body: payload.message, priority: "normal" }, logger);
	}

	return { notificationId, delivered: true };
}

export function formatNotification(result: NotificationResult): string {
	return `Notification ${result.notificationId}: ${result.delivered ? "delivered" : "pending"}`;
}