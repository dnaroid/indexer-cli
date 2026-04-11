import type { OrderItem } from "../services/order";
import type { InventoryItem, Status } from "./tracker";
import { trackInventory, restockItem } from "./tracker";
import type { Logger } from "../utils/logger";

export type InventoryAlert = {
	sku: string;
	currentQuantity: number;
	threshold: number;
};

export function checkOrderFeasibility(items: OrderItem[], inventory: InventoryItem[]): { feasible: boolean; missing: string[] } {
	const missing: string[] = [];
	const bySku = new Map(inventory.map((item) => [item.sku, item]));

	for (const item of items) {
		const stock = bySku.get(item.sku);
		if (!stock || stock.quantity < item.quantity) {
			missing.push(item.sku);
		}
	}

	return { feasible: missing.length === 0, missing };
}

export function processRestock(alerts: InventoryAlert[], logger: Logger): InventoryItem[] {
	logger.info("Processing restock alerts", { count: alerts.length });
	return alerts.map((alert) => {
		const amount = alert.threshold * 2 - alert.currentQuantity;
		return restockItem({ sku: alert.sku, name: alert.sku, quantity: alert.currentQuantity, status: "low_stock", lastRestocked: new Date() }, amount);
	});
}