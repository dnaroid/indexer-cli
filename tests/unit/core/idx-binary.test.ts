import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	realpathSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const NPX_SCRIPT_CONTENT = `#!/bin/sh
exec npm exec --yes --loglevel=silent --prefix "\${TMPDIR:-/tmp}" --package=indexer-cli@latest -- indexer-cli "$@"
`;
const EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

function thinWrapperContent(binaryPath: string): string {
	return `#!/bin/sh\nexec ${binaryPath} "$@"\n`;
}

const { execSyncMock, homedirMock, platformMock, writeFileSyncMock } =
	vi.hoisted(() => ({
		execSyncMock: vi.fn(),
		homedirMock: vi.fn(),
		platformMock: vi.fn(),
		writeFileSyncMock: vi.fn(),
	}));

vi.mock("node:child_process", () => ({
	execSync: execSyncMock,
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

async function loadIdxBinaryModule(): Promise<
	typeof import("../../../src/core/idx-binary.js")
> {
	vi.resetModules();
	return import("../../../src/core/idx-binary.js");
}

function createGlobalInstall(prefix: string): string {
	const binDir = path.join(prefix, "bin");
	const binaryPath = path.join(binDir, "indexer-cli");

	mkdirSync(binDir, { recursive: true });
	writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(binaryPath, 0o755);

	return binaryPath;
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(NPX_SCRIPT_CONTENT);
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
		writeFileSync(scriptPath, NPX_SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o755);
		writeFileSyncMock.mockClear();

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledWith(
			path.join(homeDir, ".zshrc"),
			`${EXPORT_LINE}\n`,
			"utf8",
		);
		expect(readFileSync(scriptPath, "utf8")).toBe(NPX_SCRIPT_CONTENT);
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(writeFileSyncMock).toHaveBeenCalledWith(
			scriptPath,
			NPX_SCRIPT_CONTENT,
			"utf8",
		);
		expect(readFileSync(scriptPath, "utf8")).toBe(NPX_SCRIPT_CONTENT);
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
		writeFileSync(scriptPath, NPX_SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o644);
		writeFileSyncMock.mockClear();

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(NPX_SCRIPT_CONTENT);
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		ensureIdxBinary();

		expect(readFileSync(zshrcPath, "utf8")).toBe("export FOO=bar\n");
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledWith(
			path.join(localBinDir, "idx"),
			NPX_SCRIPT_CONTENT,
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
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

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(readFileSync(zshrcPath, "utf8")).toBe(`${EXPORT_LINE}\n`);
		expect(result).toEqual({
			scriptStatus: "installed",
			pathUpdated: true,
		});
	});

	it("prefers a thin wrapper when a global binary exists", async () => {
		const homeDir = createTempDir();
		const prefix = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		const realBinaryPath = createGlobalInstall(prefix);
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;
		execSyncMock.mockImplementation((command: string) => {
			if (command === "npm config get prefix") {
				return `${prefix}\n`;
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(
			thinWrapperContent(realpathSync(realBinaryPath)),
		);
		expect(result).toEqual({
			scriptStatus: "installed",
			pathUpdated: false,
		});
	});

	it("repairs an npx wrapper when a global binary is available", async () => {
		const homeDir = createTempDir();
		const prefix = createTempDir();
		const localBinDir = path.join(homeDir, ".local", "bin");
		const scriptPath = path.join(localBinDir, "idx");
		const realBinaryPath = createGlobalInstall(prefix);
		setMockedOs(homeDir, "darwin");
		process.env.PATH = localBinDir;
		execSyncMock.mockImplementation((command: string) => {
			if (command === "npm config get prefix") {
				return `${prefix}\n`;
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		mkdirSync(localBinDir, { recursive: true });
		writeFileSync(scriptPath, NPX_SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o755);

		const { ensureIdxBinary } = await loadIdxBinaryModule();
		const result = ensureIdxBinary();

		expect(readFileSync(scriptPath, "utf8")).toBe(
			thinWrapperContent(realpathSync(realBinaryPath)),
		);
		expect(result).toEqual({
			scriptStatus: "repaired",
			pathUpdated: false,
		});
	});
});

describe("getNpmGlobalBinPath", () => {
	it("returns the resolved global binary path when present and executable", async () => {
		const prefix = createTempDir();
		const realBinaryPath = createGlobalInstall(prefix);
		execSyncMock.mockImplementation((command: string) => {
			if (command === "npm config get prefix") {
				return `${prefix}\n`;
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		const { getNpmGlobalBinPath } = await loadIdxBinaryModule();

		expect(getNpmGlobalBinPath()).toBe(realpathSync(realBinaryPath));
	});

	it("returns null when the global binary cannot be resolved", async () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("npm unavailable");
		});

		const { getNpmGlobalBinPath } = await loadIdxBinaryModule();

		expect(getNpmGlobalBinPath()).toBeNull();
	});
});

describe("installGlobal", () => {
	it("returns true when npm global install succeeds", async () => {
		execSyncMock.mockImplementation((command: string) => {
			if (command === "npm install -g indexer-cli@latest") {
				return "installed";
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		const { installGlobal } = await loadIdxBinaryModule();

		expect(installGlobal()).toBe(true);
		expect(execSyncMock).toHaveBeenCalledWith(
			"npm install -g indexer-cli@latest",
			{
				stdio: "pipe",
				encoding: "utf8",
			},
		);
	});

	it("returns false when npm global install fails", async () => {
		execSyncMock.mockImplementation((command: string) => {
			if (command === "npm install -g indexer-cli@latest") {
				throw new Error("install failed");
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		const { installGlobal } = await loadIdxBinaryModule();

		expect(installGlobal()).toBe(false);
	});
});
