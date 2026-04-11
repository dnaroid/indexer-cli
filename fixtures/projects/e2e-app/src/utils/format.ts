function toDate(value: Date | string | number): Date {
	return value instanceof Date ? value : new Date(value);
}

export function format(value: Date | string | number): string {
	const date = toDate(value);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

export function formatDate(value: Date | string | number): string {
	return format(value);
}