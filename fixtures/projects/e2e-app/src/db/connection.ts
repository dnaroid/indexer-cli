import { TIMEOUT_MS } from "../constants/app";

export type PostgresPoolHandle = {
	poolId: string;
	driverName: string;
	host: string;
	schemaName: string;
	connectedAt: number;
	poolSize: number;
	timeoutMs: number;
};

let pool: PostgresPoolHandle | null = null;

function buildDsn(host: string, schemaName: string): string {
	return `postgres://${host}/${schemaName}`;
}

export function getConnection(): PostgresPoolHandle {
	if (!pool) {
		const dsn = buildDsn("db.internal", "public");
		pool = {
			poolId: `postgres-${Date.now()}`,
			driverName: "postgres",
			host: dsn.split("//")[1]?.split("/")[0] ?? "db.internal",
			schemaName: "public",
			connectedAt: Date.now(),
			poolSize: 5,
			timeoutMs: TIMEOUT_MS,
		};
	}
	return pool;
}

export function closePool(): boolean {
	if (!pool) {
		return false;
	}
	pool = null;
	return true;
}