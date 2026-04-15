import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const SCRIPT_CONTENT =
	'#!/bin/sh\nexport npm_config_loglevel=silent\nexec npx --yes --package=indexer-cli@latest indexer-cli "$@"\n';
const EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

const { homedirMock, platformMock, writeFileSyncMock } = vi.hoisted(() => ({
	homedirMock: vi.fn(),
	platformMock: vi.fn(),
	writeFileSyncMock: vi.fn(),
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		default: {
			...actual,
			homedir: homedirMock,
			platform: platformMock,
		},
		homedir: homedirMock,
		platform: platformMock,
	};
});

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	writeFileSyncMock.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		writeFileSync: writeFileSyncMock,
	};
});

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function createTempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "idx-binary-test-"));
	tempDirs.push(dir);
	return dir;
}

function setMockedOs(homeDir: string, platform: "darwin" | "linux"): void {
	homedirMock.mockReturnValue(homeDir);
	platformMock.mockReturnValue(platform);
}

async function loadEnsureIdxBinary(): Promise<
	() => {
		scriptStatus: "unchanged" | "installed" | "repaired";
		pathUpdated: boolean;
	}
> {
	vi.resetModules();
	const module = await import("../../../src/core/idx-binary.js");
	return module.ensureIdxBinary;
}

afterEach(async () => {
	vi.clearAllMocks();
	process.env.PATH = originalPath;

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
	vi.resetModules();
});

describe("ensureIdxBinary", () => {
	it("creates idx script when it does not exist", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;

		const ensureIdxBinary = await loadEnsureIdxBinary();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(SCRIPT_CONTENT);
		expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
		expect(result).toEqual({
			scriptStatus: "installed",
			pathUpdated: false,
		});
	});

	it("skips when already installed with identical content", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = "";

		mkdirSync(localBinDir, { recursive: true });
		writeFileSync(scriptPath, SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o755);
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		const result = ensureIdxBinary();

		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledWith(
			path.join(homeDir, ".zshrc"),
			`${EXPORT_LINE}\n`,
			"utf8",
		);
		expect(readFileSync(scriptPath, "utf8")).toBe(SCRIPT_CONTENT);
		expect(result).toEqual({
			scriptStatus: "unchanged",
			pathUpdated: true,
		});
	});

	it("overwrites the script when content differs", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;

		mkdirSync(localBinDir, { recursive: true });
		writeFileSync(scriptPath, "#!/bin/sh\necho stale\n", "utf8");
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		const result = ensureIdxBinary();

		expect(writeFileSyncMock).toHaveBeenCalledWith(
			scriptPath,
			SCRIPT_CONTENT,
			"utf8",
		);
		expect(readFileSync(scriptPath, "utf8")).toBe(SCRIPT_CONTENT);
		expect(result).toEqual({
			scriptStatus: "repaired",
			pathUpdated: false,
		});
	});

	it("repairs the script when execute permissions are missing", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;

		mkdirSync(localBinDir, { recursive: true });
		writeFileSync(scriptPath, SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o644);
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(SCRIPT_CONTENT);
		expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
		expect(result).toEqual({
			scriptStatus: "repaired",
			pathUpdated: false,
		});
	});

	it("creates ~/.local/bin when it does not exist", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;

		const ensureIdxBinary = await loadEnsureIdxBinary();
		ensureIdxBinary();

		expect(statSync(localBinDir).isDirectory()).toBe(true);
	});

	it("adds PATH to .zshrc on darwin when ~/.local/bin is not in PATH", async () => {
		const homeDir = createTempDir();
		const zshrcPath = path.join(homeDir, ".zshrc");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = "/usr/bin:/bin";

		writeFileSync(zshrcPath, "export FOO=bar\n", "utf8");
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		ensureIdxBinary();

		expect(readFileSync(zshrcPath, "utf8")).toBe(
			`export FOO=bar\n${EXPORT_LINE}\n`,
		);
	});

	it("adds PATH to .bashrc on linux when ~/.local/bin is not in PATH", async () => {
		const homeDir = createTempDir();
		const bashrcPath = path.join(homeDir, ".bashrc");
		setMockedOs(homeDir, "linux");
		process.env.PATH = "/usr/bin:/bin";

		writeFileSync(bashrcPath, "export FOO=bar\n", "utf8");
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		ensureIdxBinary();

		expect(readFileSync(bashrcPath, "utf8")).toBe(
			`export FOO=bar\n${EXPORT_LINE}\n`,
		);
	});

	it("skips PATH update when ~/.local/bin is already in PATH", async () => {
		const homeDir = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const zshrcPath = path.join(homeDir, ".zshrc");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = `/usr/bin:${localBinDir}:/bin`;

		writeFileSync(zshrcPath, "export FOO=bar\n", "utf8");
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		ensureIdxBinary();

		expect(readFileSync(zshrcPath, "utf8")).toBe("export FOO=bar\n");
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledWith(
			path.join(localBinDir, "idx"),
			SCRIPT_CONTENT,
			"utf8",
		);
	});

	it("skips PATH update when the export line already exists in the profile", async () => {
		const homeDir = createTempDir();
		const zshrcPath = path.join(homeDir, ".zshrc");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = "/usr/bin:/bin";

		writeFileSync(zshrcPath, `export FOO=bar\n${EXPORT_LINE}\n`, "utf8");
		writeFileSyncMock.mockClear();

		const ensureIdxBinary = await loadEnsureIdxBinary();
		ensureIdxBinary();

		const profileContent = readFileSync(zshrcPath, "utf8");
		expect(profileContent).toBe(`export FOO=bar\n${EXPORT_LINE}\n`);
		expect(
			profileContent.match(/export PATH="\$HOME\/.local\/bin:\$PATH"/g),
		).toHaveLength(1);
	});

	it("handles missing shell profiles gracefully", async () => {
		const homeDir = createTempDir();
		const zshrcPath = path.join(homeDir, ".zshrc");
		setMockedOs(homeDir, "darwin");
		process.env.PATH = "/usr/bin:/bin";

		const ensureIdxBinary = await loadEnsureIdxBinary();
		const result = ensureIdxBinary();

		expect(readFileSync(zshrcPath, "utf8")).toBe(`${EXPORT_LINE}\n`);
		expect(result).toEqual({
			scriptStatus: "installed",
			pathUpdated: true,
		});
	});
});
