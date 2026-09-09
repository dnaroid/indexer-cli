export function formatTelemetryLabel(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "-");
}
