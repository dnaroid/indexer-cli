export type Status = "in_stock" | "low_stock" | "out_of_stock" | "discontinued";

export type InventoryItem = {
	sku: string;
	name: string;
	quantity: number;
	status: Status;
	lastRestocked: Date;
};

export function trackInventory(items: InventoryItem[]): { total: number; lowStock: number } {
	let lowStock = 0;
	for (const item of items) {
		if (item.quantity <= 5 && item.status !== "discontinued") {
			lowStock++;
		}
	}
	return { total: items.length, lowStock };
}

export function restockItem(item: InventoryItem, amount: number): InventoryItem {
	const quantity = Math.max(0, item.quantity + amount);
	const status: Status = quantity === 0 ? "out_of_stock" : quantity <= 5 ? "low_stock" : "in_stock";
	return { ...item, quantity, status, lastRestocked: new Date() };
}