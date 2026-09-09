export type JobState = "running" | "cancelled";

export function cancelJob(state: JobState): JobState {
	return state === "cancelled" ? state : "cancelled";
}
