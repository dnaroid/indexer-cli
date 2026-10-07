import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { performInit } from "../../../src/cli/commands/init.js";
import * as embeddingFactory from "../../../src/embedding/factory.js";

const tempDirs: string[] = [];

async function loadInitInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/init.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/async function pathExists[\s\S]*?(?=async function persistSkillTargets)/,
	);
	if (!match) {
		throw new Error(`Unable to extract init helpers from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`import { constants as fsConstants } from "node:fs";\nimport { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";\nimport path from "node:path";\nconst GENERATED_SKILL_DIRECTORIES = ["repo-discovery"];\nconst GENERATED_SKILLS = [];\n${match[0]}\nexport { pathExists, writeSkillsForTarget, refreshSkillsForTarget, detectInstalledSkillTargets, ensureGitignoreEntries, skillIgnoreEntries };`,
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

const initInternals = await loadInitInternals<{
	refreshSkillsForTarget: (
		projectRoot: string,
		target: "claude" | "codex",
		skillDirectories?: string[],
		skills?: Array<{ directory: string; content: string }>,
		deprecatedSkillDirectories?: string[],
	) => Promise<void>;
	detectInstalledSkillTargets: (
		projectRoot: string,
	) => Promise<Array<"claude" | "codex">>;
	ensureGitignoreEntries: (projectRoot: string, entries: string[]) => Promise<void>;
	skillIgnoreEntries: (target: "claude" | "codex") => string[];
}>();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("init command helpers", () => {
	it("scopes gitignore entries to idx-generated skill directories", () => {
		expect(initInternals.skillIgnoreEntries("claude")).toEqual([
			".claude/skills/repo-discovery/",
		]);
		expect(initInternals.skillIgnoreEntries("codex")).toEqual([
			".agents/skills/repo-discovery/",
		]);
	});

	it("treats root-anchored idx ignores as equivalent and preserves context entries", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);
		const gitignorePath = path.join(projectRoot, ".gitignore");
		writeFileSync(gitignorePath, "/.indexer-cli/\nCLAUDE.md\n", "utf8");

		await initInternals.ensureGitignoreEntries(projectRoot, [".indexer-cli/"]);

		expect(readFileSync(gitignorePath, "utf8")).toBe(
			"/.indexer-cli/\nCLAUDE.md\n",
		);
	});

	it("refreshes only this CLI's generated skill directories", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);

		const skillsRoot = path.join(projectRoot, ".claude", "skills");
		mkdirSync(path.join(skillsRoot, "repo-discovery"), { recursive: true });
		mkdirSync(path.join(skillsRoot, "custom-skill"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"stale repo discovery",
			"utf8",
		);
		writeFileSync(
			path.join(skillsRoot, "custom-skill", "SKILL.md"),
			"keep me",
			"utf8",
		);

		await initInternals.refreshSkillsForTarget(
			projectRoot,
			"claude",
			["repo-discovery"],
			[
				{
					directory: "repo-discovery",
					content: "name: repo-discovery\n",
				},
			],
		);

		const repoDiscovery = readFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"utf8",
		);
		const customSkill = readFileSync(
			path.join(skillsRoot, "custom-skill", "SKILL.md"),
			"utf8",
		);
		const skillDirectories = readdirSync(skillsRoot).sort();

		expect(repoDiscovery).toContain("name: repo-discovery");
		expect(skillDirectories).toEqual(["custom-skill", "repo-discovery"]);
		expect(customSkill).toBe("keep me");
	});

	it("removes deprecated generated skill directories during refresh", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);

		const skillsRoot = path.join(projectRoot, ".claude", "skills");
		mkdirSync(path.join(skillsRoot, "semantic-search"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "semantic-search", "SKILL.md"),
			"old multi-skill artifact",
			"utf8",
		);
		mkdirSync(path.join(skillsRoot, "context-pack"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "context-pack", "SKILL.md"),
			"deprecated skill",
			"utf8",
		);

		await initInternals.refreshSkillsForTarget(
			projectRoot,
			"claude",
			["repo-discovery"],
			[
				{
					directory: "repo-discovery",
					content: "name: repo-discovery\n",
				},
			],
			["context-pack", "semantic-search"],
		);

		expect(() =>
			readFileSync(path.join(skillsRoot, "context-pack", "SKILL.md"), "utf8"),
		).toThrow();
		expect(() =>
			readFileSync(
				path.join(skillsRoot, "semantic-search", "SKILL.md"),
				"utf8",
			),
		).toThrow();
		const repoDiscovery = readFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"utf8",
		);
		const skillDirectories = readdirSync(skillsRoot);
		expect(repoDiscovery).toContain("name: repo-discovery");
		expect(skillDirectories).toEqual(["repo-discovery"]);
	});

	it("writes and detects Codex skills under .agents/skills", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);
		const preexistingCodexSkill = path.join(
			projectRoot,
			".agents",
			"skills",
			"context-pack",
			"SKILL.md",
		);
		mkdirSync(path.dirname(preexistingCodexSkill), { recursive: true });
		writeFileSync(preexistingCodexSkill, "user-owned\n", "utf8");

		await initInternals.refreshSkillsForTarget(
			projectRoot,
			"codex",
			["repo-discovery"],
			[
				{
					directory: "repo-discovery",
					content: "name: repo-discovery\n",
				},
			],
		);

		expect(
			readFileSync(
				path.join(
					projectRoot,
					".agents",
					"skills",
					"repo-discovery",
					"SKILL.md",
				),
				"utf8",
			),
		).toContain("name: repo-discovery");
		expect(readFileSync(preexistingCodexSkill, "utf8")).toBe("user-owned\n");
		expect(await initInternals.detectInstalledSkillTargets(projectRoot)).toEqual([
			"codex",
		]);
	});
});

describe("init command source", () => {
	it("defaults new projects to OpenRouter and preserves the preset and storage on repeated init", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-default-"));
		tempDirs.push(projectRoot);
		await performInit(projectRoot, { skipIndexing: true });
		const configPath = path.join(projectRoot, ".indexer-cli", "config.json");
		const stored = JSON.parse(readFileSync(configPath, "utf8"));
		expect(stored).toMatchObject({
			embeddingProvider: "openrouter",
			embeddingModel: "perplexity/pplx-embed-v1-0.6b",
			knowledgeEmbeddingModel: "perplexity/pplx-embed-v1-0.6b",
			knowledgeEmbeddingQueryPrefix: "",
			knowledgeEmbeddingDocumentPrefix: "",
			embeddingContextSize: 32768,
			vectorSize: 1024,
		});
		const dbPath = path.join(projectRoot, ".indexer-cli", "db.sqlite");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE init_sentinel (value TEXT)");
		db.close();
		await performInit(projectRoot, { skipIndexing: true });
		const reopened = new Database(dbPath, { readonly: true });
		try {
			expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'init_sentinel'").get()).toBeDefined();
		} finally {
			reopened.close();
		}
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			embeddingProvider: stored.embeddingProvider,
			embeddingModel: stored.embeddingModel,
			knowledgeEmbeddingModel: stored.knowledgeEmbeddingModel,
			knowledgeEmbeddingQueryPrefix: stored.knowledgeEmbeddingQueryPrefix,
			knowledgeEmbeddingDocumentPrefix: stored.knowledgeEmbeddingDocumentPrefix,
			embeddingContextSize: stored.embeddingContextSize,
			vectorSize: stored.vectorSize,
		});
	});

	it("preserves an existing local project without an explicit embedding option", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-local-"));
		tempDirs.push(projectRoot);
		await performInit(projectRoot, { skipIndexing: true, embedding: "local" });
		await performInit(projectRoot, { skipIndexing: true });
		expect(JSON.parse(readFileSync(path.join(projectRoot, ".indexer-cli", "config.json"), "utf8"))).toMatchObject({
			embeddingProvider: "ollama", vectorSize: 768,
		});
	});

	it("rejects default OpenRouter initialization without credentials before creating storage", async () => {
		vi.spyOn(embeddingFactory, "loadOpenRouterApiKey").mockReturnValue(undefined);
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-no-key-"));
		tempDirs.push(projectRoot);
		await expect(performInit(projectRoot)).rejects.toThrow("requires OPENROUTER_API_KEY");
		expect(() => readFileSync(path.join(projectRoot, ".indexer-cli", "config.json"))).toThrow();
		expect(() => readFileSync(path.join(projectRoot, ".indexer-cli", "db.sqlite"))).toThrow();
	});

	it.each(["local", "openrouter"] as const)("leaves existing %s storage untouched when OpenRouter credentials are missing", async (embedding) => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-preserve-"));
		tempDirs.push(projectRoot);
		await performInit(projectRoot, { skipIndexing: true, embedding });
		const configPath = path.join(projectRoot, ".indexer-cli", "config.json");
		const dbPath = path.join(projectRoot, ".indexer-cli", "db.sqlite");
		const previousConfig = readFileSync(configPath);
		const previousDb = readFileSync(dbPath);
		vi.spyOn(embeddingFactory, "loadOpenRouterApiKey").mockReturnValue(undefined);
		// Exercise both an explicit switch and repeated init of stored OpenRouter.
		await expect(performInit(projectRoot, embedding === "local" ? { embedding: "openrouter" } : undefined))
			.rejects.toThrow("requires OPENROUTER_API_KEY");
		expect(readFileSync(configPath)).toEqual(previousConfig);
		expect(readFileSync(dbPath)).toEqual(previousDb);
	});

	it("keeps local fallback for legacy config without an embedding provider", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-legacy-"));
		tempDirs.push(projectRoot);
		await performInit(projectRoot, { skipIndexing: true, embedding: "local" });
		const configPath = path.join(projectRoot, ".indexer-cli", "config.json");
		const stored = JSON.parse(readFileSync(configPath, "utf8"));
		delete stored.embeddingProvider;
		writeFileSync(configPath, JSON.stringify(stored));
		await performInit(projectRoot, { skipIndexing: true });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			embeddingProvider: "ollama", vectorSize: 768,
		});
	});

	it("does not install or modify Git hooks", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/init.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/hooks|post-commit/);
	});

	it("documents first-run indexing progress and troubleshooting in the command output", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/init.ts"),
			"utf8",
		);
		expect(source).toContain("Starting initial index.");
		expect(source).toContain("download/create the jina-8k embedding model");
		expect(source).toContain("Starting initial index with OpenRouter embeddings.");
		expect(source).toContain("idx --no-auto-update doctor .");
		expect(source).toContain("selected embedding provider");
	});

	it("persists the OpenRouter embedding preset and rebuilds 768-dim storage as 1024-dim", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-openrouter-"));
		tempDirs.push(projectRoot);

		await performInit(projectRoot, { skipIndexing: true, embedding: "local" });
		const dbPath = path.join(projectRoot, ".indexer-cli", "db.sqlite");
		const firstDb = new Database(dbPath);
		firstDb.exec("CREATE TABLE embedding_switch_sentinel (value TEXT)");
		firstDb.close();

		await performInit(projectRoot, {
			skipIndexing: true,
			embedding: "openrouter",
		});

		const stored = JSON.parse(
			readFileSync(path.join(projectRoot, ".indexer-cli", "config.json"), "utf8"),
		) as Record<string, unknown>;
		expect(stored.embeddingProvider).toBe("openrouter");
		expect(stored.embeddingModel).toBe("perplexity/pplx-embed-v1-0.6b");
		expect(stored.knowledgeEmbeddingModel).toBe("perplexity/pplx-embed-v1-0.6b");
		expect(stored.knowledgeEmbeddingQueryPrefix).toBe("");
		expect(stored.knowledgeEmbeddingDocumentPrefix).toBe("");
		expect(stored.embeddingContextSize).toBe(32768);
		expect(stored.vectorSize).toBe(1024);

		const secondDb = new Database(dbPath, { readonly: true });
		try {
			const sentinel = secondDb
				.prepare("SELECT name FROM sqlite_master WHERE name = 'embedding_switch_sentinel'")
				.get();
			const vec = secondDb
				.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'")
				.get() as { sql?: string } | undefined;
			expect(sentinel).toBeUndefined();
			expect(vec?.sql).toMatch(/embedding\s+float\[1024\]/i);
		} finally {
			secondDb.close();
		}
	});
});
