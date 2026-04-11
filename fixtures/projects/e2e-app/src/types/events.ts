export type EventMap = Record<string, unknown>;

export type EventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;

export class TypedEventEmitter<TEvents extends EventMap> {
	private readonly listeners = new Map<keyof TEvents, Set<EventHandler<TEvents[keyof TEvents]>>>();

	on<TKey extends keyof TEvents>(eventName: TKey, handler: EventHandler<TEvents[TKey]>): void {
		const handlers = this.listeners.get(eventName) ?? new Set<EventHandler<TEvents[keyof TEvents]>>();
		handlers.add(handler as EventHandler<TEvents[keyof TEvents]>);
		this.listeners.set(eventName, handlers);
	}

	async emit<TKey extends keyof TEvents>(eventName: TKey, payload: TEvents[TKey]): Promise<void> {
		const handlers = this.listeners.get(eventName);
		for (const handler of handlers ?? []) {
			await handler(payload);
		}
	}
}