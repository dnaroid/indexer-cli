import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

async function loadSetupInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/setup.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/function normalizeCommandOutput[\s\S]*?(?=\/\/ ── Summary)/,
	);
	if (!match) {
		throw new Error(`Unable to extract internals from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`${match[0]}\nexport { normalizeCommandOutput, collectOllamaResults, createSkippedResult };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return (await import(moduleUrl)) as T;
}

async function loadInstallIdxBinary(
	ensureIdxBinary: () => {
		scriptStatus: "unchanged" | "installed" | "repaired";
		pathUpdated: boolean;
		launchMode: "global-wrapper" | "repair-wrapper";
		targetPath: string | null;
	},
	homedir = "/tmp/home",
): Promise<() => { name: string; status: string; detail?: string }> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/setup.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/function installIdxBinary[\s\S]*?(?=\/\/ ── Ollama)/,
	);
	if (!match) {
		throw new Error(`Unable to extract installIdxBinary from ${filePath}`);
	}

	(
		globalThis as typeof globalThis & { __setupTestMocks?: unknown }
	).__setupTestMocks = {
		ensureIdxBinary,
		homedir,
	};

	const transpiled = ts.transpileModule(
		`const os = { homedir: () => globalThis.__setupTestMocks.homedir };
const path = { join: (...parts) => parts.join("/") };
const ensureIdxBinary = globalThis.__setupTestMocks.ensureIdxBinary;
${match[0]}
export { installIdxBinary };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}#${Math.random().toString(36).slice(2)}`;
	const module = (await import(moduleUrl)) as {
		installIdxBinary: () => { name: string; status: string; detail?: string };
	};
	return module.installIdxBinary;
}

const setupInternals = await loadSetupInternals<{
	normalizeCommandOutput: (output: string | Buffer | null) => string;
	collectOllamaResults: (deps: {
		checkOllama: () => {
			name: string;
			status: "ok" | "installed" | "failed" | "skipped";
			detail?: string;
		};
		ensureOllamaRunning: () => {
			name: string;
			status: "ok" | "installed" | "failed" | "skipped";
			detail?: string;
		};
		checkJinaModel: () => {
			name: string;
			status: "ok" | "installed" | "failed" | "skipped";
			detail?: string;
		};
	}) => Array<{
		name: string;
		status: "ok" | "installed" | "failed" | "skipped";
		detail?: string;
	}>;
}>();

describe("setup command helpers", () => {
	it("normalizes command output safely when stdio is inherited", () => {
		expect(setupInternals.normalizeCommandOutput(null)).toBe("");
		expect(setupInternals.normalizeCommandOutput("  ok\n")).toBe("ok");
		expect(setupInternals.normalizeCommandOutput(Buffer.from("  fine\n"))).toBe(
			"fine",
		);
	});

	it("skips daemon and model checks when Ollama is missing", () => {
		const ensureOllamaRunning = vi.fn(() => ({
			name: "Ollama daemon",
			status: "ok" as const,
		}));
		const checkJinaModel = vi.fn(() => ({
			name: "Model jina-8k",
			status: "ok" as const,
		}));

		const results = setupInternals.collectOllamaResults({
			checkOllama: () => ({
				name: "Ollama",
				status: "failed",
				detail: "Install manually",
			}),
			ensureOllamaRunning,
			checkJinaModel,
		});

		expect(results).toEqual([
			{ name: "Ollama", status: "failed", detail: "Install manually" },
			{
				name: "Ollama daemon",
				status: "skipped",
				detail: "Skipped until Ollama is installed manually.",
			},
			{
				name: "Model jina-8k",
				status: "skipped",
				detail: "Skipped until Ollama is installed manually.",
			},
		]);
		expect(ensureOllamaRunning).not.toHaveBeenCalled();
		expect(checkJinaModel).not.toHaveBeenCalled();
	});

	it("skips model setup when the Ollama daemon cannot be started", () => {
		const checkJinaModel = vi.fn(() => ({
			name: "Model jina-8k",
			status: "ok" as const,
		}));

		const results = setupInternals.collectOllamaResults({
			checkOllama: () => ({
				name: "Ollama",
				status: "ok",
				detail: "installed",
			}),
			ensureOllamaRunning: () => ({
				name: "Ollama daemon",
				status: "failed",
				detail: "Timed out",
			}),
			checkJinaModel,
		});

		expect(results).toEqual([
			{ name: "Ollama", status: "ok", detail: "installed" },
			{ name: "Ollama daemon", status: "failed", detail: "Timed out" },
			{
				name: "Model jina-8k",
				status: "skipped",
				detail: "Skipped until the Ollama daemon is running.",
			},
		]);
		expect(checkJinaModel).not.toHaveBeenCalled();
	});

	it("checks the embedding model when Ollama is ready", () => {
		const checkJinaModel = vi.fn(() => ({
			name: "Model jina-8k",
			status: "ok" as const,
			detail: "pulled",
		}));

		const results = setupInternals.collectOllamaResults({
			checkOllama: () => ({
				name: "Ollama",
				status: "ok",
				detail: "installed",
			}),
			ensureOllamaRunning: () => ({
				name: "Ollama daemon",
				status: "ok",
				detail: "running",
			}),
			checkJinaModel,
		});

		expect(results).toEqual([
			{ name: "Ollama", status: "ok", detail: "installed" },
			{ name: "Ollama daemon", status: "ok", detail: "running" },
			{ name: "Model jina-8k", status: "ok", detail: "pulled" },
		]);
		expect(checkJinaModel).toHaveBeenCalledTimes(1);
	});

	it("reports repaired idx wrapper scripts explicitly", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/bin";

		try {
			const installIdxBinary = await loadInstallIdxBinary(() => ({
				scriptStatus: "repaired",
				pathUpdated: false,
				launchMode: "global-wrapper",
				targetPath: "/usr/local/bin/indexer-cli",
			}));

			expect(installIdxBinary()).toEqual({
				name: "idx command",
				status: "repaired",
				detail: "wrapper repaired; restart your shell",
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("reports a healthy idx wrapper when no repair is needed", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/tmp/home/.local/bin:/bin";

		try {
			const installIdxBinary = await loadInstallIdxBinary(() => ({
				scriptStatus: "unchanged",
				pathUpdated: false,
				launchMode: "global-wrapper",
				targetPath: "/usr/local/bin/indexer-cli",
			}));

			expect(installIdxBinary()).toEqual({
				name: "idx command",
				status: "ok",
				detail: "healthy",
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("reports a repaired idx wrapper when execute permissions are restored", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/tmp/home/.local/bin:/bin";

		try {
			const installIdxBinary = await loadInstallIdxBinary(() => ({
				scriptStatus: "repaired",
				pathUpdated: false,
				launchMode: "global-wrapper",
				targetPath: "/usr/local/bin/indexer-cli",
			}));

			expect(installIdxBinary()).toEqual({
				name: "idx command",
				status: "repaired",
				detail: "wrapper repaired",
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
