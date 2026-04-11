import { MAX_RETRIES } from "../constants/app";
import { capitalize, truncate } from "../helpers/strings";
import { TypedEventEmitter } from "../types/events";

type QueueDeliveryEnvelope = {
	id: string;
	queueTopic: string;
	handlerKey: string;
	attempts: number;
	reservationId?: string;
	payload: Record<string, unknown>;
};

const workerEvents = new TypedEventEmitter<{ acknowledged: QueueDeliveryEnvelope; requeued: QueueDeliveryEnvelope }>();

function buildReservationId(job: QueueDeliveryEnvelope): string {
	return `${job.queueTopic}:${job.handlerKey}:${truncate(job.id, 8)}`;
}

export async function processJob(job: QueueDeliveryEnvelope): Promise<string> {
	await workerEvents.emit("acknowledged", job);
	const label = `${capitalize(job.queueTopic)}:${capitalize(job.handlerKey)}`;
	return `${label}:${buildReservationId(job)}`;
}

export async function retryJob(job: QueueDeliveryEnvelope): Promise<QueueDeliveryEnvelope> {
	const attempts = Math.min(job.attempts + 1, MAX_RETRIES);
	const nextJob = { ...job, attempts, reservationId: buildReservationId(job) };
	await workerEvents.emit("requeued", nextJob);
	return nextJob;
}