import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RegistryEntry {
	projectPath: string;
	cliVersion: string;
	skillsVersion: number;
	registeredAt: string;
}

export interface RegistryData {
	projects: RegistryEntry[];
}

export function getRegistryDir(): string {
	const home = process.env["INDEXER_CLI_HOME"] ?? os.homedir();
	return path.join(home, ".indexer-cli");
}

export function getRegistryPath(): string {
	return path.join(getRegistryDir(), "registry.json");
}

export function loadRegistry(registryPath?: string): RegistryData {
	const filePath = registryPath ?? getRegistryPath();

	if (!existsSync(filePath)) {
		return { projects: [] };
	}

	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"projects" in parsed &&
			Array.isArray((parsed as RegistryData).projects)
		) {
			return parsed as RegistryData;
		}

		return { projects: [] };
	} catch {
		return { projects: [] };
	}
}

export function saveRegistry(data: RegistryData, registryPath?: string): void {
	const filePath = registryPath ?? getRegistryPath();
	const dir = path.dirname(filePath);

	mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function addProject(
	entry: Omit<RegistryEntry, "registeredAt">,
	registryPath?: string,
): void {
	const data = loadRegistry(registryPath);
	const normalizedPath = path.resolve(entry.projectPath);

	const existingIdx = data.projects.findIndex(
		(p) => path.resolve(p.projectPath) === normalizedPath,
	);

	const newEntry: RegistryEntry = {
		...entry,
		projectPath: normalizedPath,
		registeredAt: new Date().toISOString(),
	};

	if (existingIdx >= 0) {
		data.projects[existingIdx] = newEntry;
	} else {
		data.projects.push(newEntry);
	}

	saveRegistry(data, registryPath);
}

export function removeProject(
	projectPath: string,
	registryPath?: string,
): void {
	const data = loadRegistry(registryPath);
	const normalizedPath = path.resolve(projectPath);

	const filtered = data.projects.filter(
		(p) => path.resolve(p.projectPath) !== normalizedPath,
	);

	if (filtered.length === data.projects.length) {
		return;
	}

	data.projects = filtered;
	saveRegistry(data, registryPath);
}

export function getRegisteredProjects(registryPath?: string): RegistryEntry[] {
	return loadRegistry(registryPath).projects;
}

export function cleanStaleEntries(registryPath?: string): RegistryEntry[] {
	const data = loadRegistry(registryPath);
	const stale: RegistryEntry[] = [];
	const valid: RegistryEntry[] = [];

	for (const entry of data.projects) {
		const configPath = path.join(
			path.resolve(entry.projectPath),
			".indexer-cli",
			"config.json",
		);
		if (existsSync(configPath)) {
			valid.push(entry);
		} else {
			stale.push(entry);
		}
	}

	if (stale.length > 0) {
		data.projects = valid;
		saveRegistry(data, registryPath);
	}

	return stale;
}
