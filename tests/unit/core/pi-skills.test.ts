import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensurePiSkillsSymlink,
	isPiInstalled,
	removePiSkillsSymlink,
} from "../../../src/core/pi-skills.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function createTempDir(prefix = "indexer-cli-pi-skills-"): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function addFakePiToPath(): string {
	const binDir = createTempDir("indexer-cli-pi-bin-");
	const piPath = path.join(binDir, "pi");
	writeFileSync(piPath, "#!/bin/sh\necho pi\n", "utf8");
	chmodSync(piPath, 0o755);
	process.env.PATH = originalPath ? `${binDir}${path.delimiter}${originalPath}` : binDir;
	return piPath;
}

afterEach(async () => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("pi skills integration", () => {
	it("detects pi when a pi executable is on PATH", () => {
		process.env.PATH = "";
		expect(isPiInstalled()).toBe(false);

		addFakePiToPath();
		expect(isPiInstalled()).toBe(true);
	});

	it("creates .pi as a symlink to .claude when pi is installed", async () => {
		addFakePiToPath();
		const projectRoot = createTempDir();
		mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });

		const created = await ensurePiSkillsSymlink(projectRoot, { silent: true });

		expect(created).toBe(true);
		expect(lstatSync(path.join(projectRoot, ".pi")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(path.join(projectRoot, ".pi"))).toBe(".claude");
	});

	it("does not create .pi when pi is not installed", async () => {
		process.env.PATH = "";
		const projectRoot = createTempDir();
		mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });

		const created = await ensurePiSkillsSymlink(projectRoot, { silent: true });

		expect(created).toBe(false);
		expect(() => lstatSync(path.join(projectRoot, ".pi"))).toThrow();
	});

	it("does not replace a real .pi directory", async () => {
		addFakePiToPath();
		const projectRoot = createTempDir();
		mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
		mkdirSync(path.join(projectRoot, ".pi"));

		const created = await ensurePiSkillsSymlink(projectRoot, { silent: true });

		expect(created).toBe(false);
		expect(lstatSync(path.join(projectRoot, ".pi")).isDirectory()).toBe(true);
	});

	it("removes only the generated .pi symlink", async () => {
		addFakePiToPath();
		const projectRoot = createTempDir();
		mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
		await ensurePiSkillsSymlink(projectRoot, { silent: true });

		const removed = await removePiSkillsSymlink(projectRoot);

		expect(removed).toBe(true);
		expect(() => lstatSync(path.join(projectRoot, ".pi"))).toThrow();
	});
});
