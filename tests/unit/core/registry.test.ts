import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addProject,
	cleanStaleEntries,
	loadRegistry,
	removeProject,
	saveRegistry,
	getRegisteredProjects,
	type RegistryData,
	type RegistryEntry,
} from "../../../src/core/registry.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-cli-registry-"));
	tempDirs.push(dir);
	return dir;
}

function registryPath(tmpDir: string): string {
	return path.join(tmpDir, "registry.json");
}

function makeEntry(
	projectPath: string,
	cliVersion = "1.0.0",
	skillsVersion = 1,
): Omit<RegistryEntry, "registeredAt"> {
	return { projectPath, cliVersion, skillsVersion };
}

function writeRegistry(filePath: string, data: RegistryData): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

function readRegistry(filePath: string): RegistryData {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function touchConfig(projectPath: string): void {
	const configPath = path.join(projectPath, ".indexer-cli", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, "{}", "utf8");
}

describe("loadRegistry", () => {
	it("returns empty when file does not exist", () => {
		const tmpDir = makeTempDir();
		const result = loadRegistry(registryPath(tmpDir));
		expect(result).toEqual({ projects: [] });
	});

	it("returns empty for corrupt/invalid JSON", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(filePath, "{ broken json", "utf8");

		const result = loadRegistry(filePath);
		expect(result).toEqual({ projects: [] });
	});

	it("returns empty for valid JSON but wrong structure", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		fs.writeFileSync(filePath, JSON.stringify({ entries: [] }), "utf8");

		const result = loadRegistry(filePath);
		expect(result).toEqual({ projects: [] });
	});

	it("reads valid registry correctly", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		const data: RegistryData = {
			projects: [
				{
					projectPath: "/some/project",
					cliVersion: "1.0.0",
					skillsVersion: 1,
					registeredAt: "2025-01-01T00:00:00.000Z",
				},
			],
		};
		fs.writeFileSync(filePath, JSON.stringify(data), "utf8");

		const result = loadRegistry(filePath);
		expect(result).toEqual(data);
	});
});

describe("addProject", () => {
	it("creates new registry file and adds entry", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/my/project"), filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
		expect(saved.projects[0].projectPath).toBe(path.resolve("/my/project"));
		expect(saved.projects[0].cliVersion).toBe("1.0.0");
		expect(saved.projects[0].skillsVersion).toBe(1);
		expect(saved.projects[0].registeredAt).toBeTruthy();
	});

	it("updates existing entry with same path instead of duplicating", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/my/project", "1.0.0", 1), filePath);
		addProject(makeEntry("/my/project", "2.0.0", 2), filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
		expect(saved.projects[0].cliVersion).toBe("2.0.0");
		expect(saved.projects[0].skillsVersion).toBe(2);
	});

	it("normalizes project paths", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/my/./project/../project"), filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
		expect(saved.projects[0].projectPath).toBe(path.resolve("/my/project"));
	});

	it("adds multiple different projects", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/project-a"), filePath);
		addProject(makeEntry("/project-b"), filePath);
		addProject(makeEntry("/project-c"), filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(3);
		const paths = saved.projects.map((p) => p.projectPath);
		expect(paths).toContain(path.resolve("/project-a"));
		expect(paths).toContain(path.resolve("/project-b"));
		expect(paths).toContain(path.resolve("/project-c"));
	});
});

describe("removeProject", () => {
	it("removes an entry by path", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/project-a"), filePath);
		addProject(makeEntry("/project-b"), filePath);

		removeProject("/project-a", filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
		expect(saved.projects[0].projectPath).toBe(path.resolve("/project-b"));
	});

	it("is a no-op when project not in registry", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/project-a"), filePath);

		removeProject("/project-unknown", filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
	});

	it("normalizes paths when matching", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/my/project"), filePath);

		removeProject("/my/./project/../project", filePath);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(0);
	});
});

describe("getRegisteredProjects", () => {
	it("returns all entries", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);

		addProject(makeEntry("/project-a"), filePath);
		addProject(makeEntry("/project-b"), filePath);

		const projects = getRegisteredProjects(filePath);
		expect(projects).toHaveLength(2);
	});
});

describe("cleanStaleEntries", () => {
	it("removes entries where .indexer-cli/config.json no longer exists", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		const projectA = path.join(tmpDir, "project-a");
		const projectB = path.join(tmpDir, "project-b");

		fs.mkdirSync(projectA, { recursive: true });
		fs.mkdirSync(projectB, { recursive: true });
		touchConfig(projectA);

		writeRegistry(filePath, {
			projects: [
				{
					projectPath: projectA,
					cliVersion: "1.0.0",
					skillsVersion: 1,
					registeredAt: "2025-01-01T00:00:00.000Z",
				},
				{
					projectPath: projectB,
					cliVersion: "1.0.0",
					skillsVersion: 1,
					registeredAt: "2025-01-01T00:00:00.000Z",
				},
			],
		});

		const removed = cleanStaleEntries(filePath);

		expect(removed).toHaveLength(1);
		expect(removed[0].projectPath).toBe(projectB);

		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
		expect(saved.projects[0].projectPath).toBe(projectA);
	});

	it("keeps valid entries", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		const projectA = path.join(tmpDir, "project-a");

		fs.mkdirSync(projectA, { recursive: true });
		touchConfig(projectA);

		writeRegistry(filePath, {
			projects: [
				{
					projectPath: projectA,
					cliVersion: "1.0.0",
					skillsVersion: 1,
					registeredAt: "2025-01-01T00:00:00.000Z",
				},
			],
		});

		const removed = cleanStaleEntries(filePath);

		expect(removed).toHaveLength(0);
		const saved = readRegistry(filePath);
		expect(saved.projects).toHaveLength(1);
	});

	it("returns the list of removed entries", () => {
		const tmpDir = makeTempDir();
		const filePath = registryPath(tmpDir);
		const staleProject = path.join(tmpDir, "stale");

		fs.mkdirSync(staleProject, { recursive: true });

		const entry: RegistryEntry = {
			projectPath: staleProject,
			cliVersion: "3.0.0",
			skillsVersion: 5,
			registeredAt: "2025-06-15T12:00:00.000Z",
		};

		writeRegistry(filePath, { projects: [entry] });

		const removed = cleanStaleEntries(filePath);

		expect(removed).toEqual([entry]);
	});
});

describe("saveRegistry", () => {
	it("creates directory if it does not exist", () => {
		const tmpDir = makeTempDir();
		const filePath = path.join(tmpDir, "nested", "sub", "registry.json");

		saveRegistry({ projects: [] }, filePath);

		expect(fs.existsSync(filePath)).toBe(true);
		expect(readRegistry(filePath)).toEqual({ projects: [] });
	});
});
