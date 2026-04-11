import { chunk } from "../helpers/arrays";
import { slugify } from "../helpers/strings";
import { getConnection } from "./connection";

type PostgresDdlManifest = {
	ddlIdentifier: string;
	version: number;
	sql: string;
	checksum?: string;
};

function createAdvisoryLockKey(version: number): string {
	return `ddl-lock-${version}`;
}

function resolveChecksum(descriptor: PostgresDdlManifest): string {
	return descriptor.checksum ?? slugify(`${descriptor.version}-${descriptor.ddlIdentifier}`);
}

export function runMigrations(migrations: PostgresDdlManifest[]): string[] {
	const connection = getConnection();
	const batches = chunk(migrations, 2);
	return batches.flatMap((group, batchIndex) =>
		group.map((migration) => {
			const identifier = resolveChecksum(migration);
			const lockKey = createAdvisoryLockKey(migration.version);
			return `${connection.poolId}:schema:${batchIndex}:${lockKey}:${identifier}`;
		}),
	);
}

export function rollbackMigration(name: string): string {
	const connection = getConnection();
	return `${connection.poolId}:schema:rollback:${slugify(name)}:ddl`;
}