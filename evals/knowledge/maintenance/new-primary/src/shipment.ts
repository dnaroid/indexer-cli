export type ShipmentState = "open" | "frozen";

export function canDispatchShipment(state: ShipmentState): boolean {
	return state !== "frozen";
}
