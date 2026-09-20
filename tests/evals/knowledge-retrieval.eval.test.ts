import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../../src/core/config.js";
import { OllamaEmbeddingProvider } from "../../src/embedding/ollama.js";
import { DocumentIndexer } from "../../src/knowledge/document-indexer.js";
import { KnowledgeSearchEngine } from "../../src/knowledge/search.js";
import { KnowledgeService } from "../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../src/storage/vectors.js";
import type { KnowledgeVerificationReceipt } from "../../src/core/types.js";

type RetrievalEval = {
	id: string;
	query: string;
	expectedPath: string;
};

const PRIMARY_METADATA: Record<
	string,
	{ summary: string; topics: string[] }
> = {
	"docs/session-recovery.md": {
		summary:
			"Recover the visible conversation from durable raw history after context compaction or pruning.",
		topics: ["session recovery", "context compaction", "raw history", "pruning"],
	},
	"specs/dcp-provider-cache-stability.md": {
		summary:
			"Keep provider-visible tool results deterministic until observed so prompt-cache reuse remains stable.",
		topics: ["dcp", "provider cache", "prompt cache", "tool results"],
	},
	"docs/concurrency.md": {
		summary:
			"Late asynchronous callbacks update the originating session/tab rather than whichever tab is currently active.",
		topics: ["async callback", "session ownership", "tab concurrency", "stale callback"],
	},
	"specs/question-inactive-tab.md": {
		summary:
			"Questions remain owned by inactive sessions and surface when their originating tab is selected.",
		topics: ["question", "inactive tab", "pending question", "session"],
	},
	"specs/openai-codex-usage-refresh.md": {
		summary:
			"Refresh OpenAI Codex usage/account limits through one deduplicated in-flight model usage request.",
		topics: ["openai codex", "usage refresh", "model usage status", "account limits"],
	},
	"docs/desktop-task-manager.md": {
		summary:
			"Display and mutate project tasks from the desktop WorkspaceSidebar while preserving project ownership.",
		topics: ["desktop", "task manager", "workspace sidebar", "tasks"],
	},
	"specs/window-state-restoration.md": {
		summary:
			"Restore desktop window bounds while clamping stale offscreen coordinates to currently attached displays.",
		topics: ["desktop window", "position restore", "offscreen", "monitor"],
	},
	"specs/file-link-opening.md": {
		summary:
			"Open project-local Markdown file links inside the desktop app while external URLs use the browser path.",
		topics: ["markdown link", "file opening", "desktop", "local file"],
	},
	"specs/attachments.md": {
		summary:
			"Convert local image attachments into multimodal model-request image content while preserving message ownership.",
		topics: ["image attachment", "multimodal", "local path", "message"],
	},
	"specs/background-agent-cancellation.md": {
		summary:
			"Cancel a background agent child operation once, propagate cancellation, and ignore late successful completion.",
		topics: ["background agent", "cancellation", "child operation", "idempotent stop"],
	},
};

const RELATED_CODE_FILES = [
	"src/session/recovery.ts",
	"tests/session/recovery.test.ts",
	"src/dcp/provider-cache.ts",
	"tests/dcp/provider-cache.test.ts",
	"src/sessions/concurrency.ts",
	"tests/sessions/concurrency.test.ts",
	"src/questions/session-question.ts",
	"tests/questions/inactive-tab.test.ts",
	"src/app/model/model-usage-status.ts",
	"tests/model/model-usage-status.test.ts",
	"desktop/src/components/WorkspaceSidebar.svelte",
	"desktop/src/lib/tasks.ts",
	"desktop/tests/tasks.test.ts",
	"desktop/src/window-state.ts",
	"desktop/tests/window-state.test.ts",
	"desktop/src/links/open-file.ts",
	"desktop/tests/file-link-opening.test.ts",
	"src/messages/attachments.ts",
	"tests/messages/attachments.test.ts",
	"src/agents/background-cancel.ts",
	"tests/agents/background-cancel.test.ts",
];

const runEval = process.env.RUN_KNOWLEDGE_EVAL === "1" ? describe : describe.skip;

async function verify(service: KnowledgeService, path: string): Promise<void> {
	const prepared = await service.prepareVerification(path);
	const receipt: KnowledgeVerificationReceipt = {
		version: 1, sourcePath: prepared.sourcePath, sourceHash: prepared.sourceHash,
		relationsHash: prepared.relationsHash, inputs: prepared.inputs, preparedAt: 1,
		reviewer: "retrieval-eval", rationale: "Reviewed retrieval fixture assertion against prepared source.",
		assertionReferences: ["fixture assertion"], evidenceReferences: ["prepared source"],
		assertionBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash, assertion: "fixture assertion" }],
		evidenceBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash }],
		limitations: ["No command was executed."],
		...(prepared.inputs.length === 0 ? { zeroTrackedInputsAcknowledged: true } : {}),
	};
	await service.verify(path, receipt);
}

runEval("real embedding knowledge retrieval eval", () => {
	it(
		"meets multilingual/paraphrase/path retrieval targets",
		async () => {
			const repoRoot = process.cwd();
			const fixtureRoot = path.join(repoRoot, "evals/knowledge/files");
			const evals = JSON.parse(
				await readFile(path.join(repoRoot, "evals/knowledge/retrieval-evals.json"), "utf8"),
			) as RetrievalEval[];
			const root = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-eval-"));
			const dbPath = path.join(root, ".indexer-cli/db.sqlite");
			await mkdir(path.dirname(dbPath), { recursive: true });
			await cp(fixtureRoot, root, { recursive: true });
			for (const filePath of RELATED_CODE_FILES) {
				await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
				await writeFile(
					path.join(root, filePath),
					`// retrieval eval fixture: ${filePath}\nexport const fixture = true;\n`,
					"utf8",
				);
			}

			const metadata = new SqliteMetadataStore(dbPath);
			const vectors = new SqliteVecVectorStore({
				dbPath,
				vectorSize: config.get("vectorSize"),
			});
			const knowledgeEmbedder = new OllamaEmbeddingProvider(
				config.get("ollamaBaseUrl"),
				config.get("knowledgeEmbeddingModel"),
				config.get("indexBatchSize"),
				config.get("indexConcurrency"),
				config.get("ollamaNumCtx"),
			);

			try {
				await Promise.all([
					metadata.initialize(),
					vectors.initialize(),
					knowledgeEmbedder.initialize(),
				]);
				const snapshot = await metadata.createSnapshot("default", {
					indexedAt: Date.now(),
					headCommit: "retrieval-eval",
				});
				const documentIndexer = new DocumentIndexer(
					root,
					metadata,
					metadata,
					vectors,
					knowledgeEmbedder,
				);
				const indexed = await documentIndexer.indexFull("default", snapshot.id);
				expect(indexed.errors).toEqual([]);
				const service = new KnowledgeService("default", root, metadata, metadata);

				for (const [filePath, semantic] of Object.entries(PRIMARY_METADATA)) {
					await service.record({
						path: filePath,
						classification: "spec",
						behaviorType: "as-is",
						lifecycle: "active",
						confidence: "high",
						summary: semantic.summary,
						topics: semantic.topics,
					});
					await verify(service, filePath);
				}
				await service.record({
					path: "docs/overview.md",
					classification: "meta-index",
					summary: "Derived overview/catalog of primary project contracts.",
				});
				await service.record({
					path: "docs/how-to.md",
					classification: "guide",
					summary: "Developer workflow guide, not a normative contract.",
				});

				const search = new KnowledgeSearchEngine(
					"default",
					snapshot.id,
					metadata,
					metadata,
					vectors,
					knowledgeEmbedder,
					service,
				);
				let top1 = 0;
				let top3 = 0;
				let top5 = 0;
				const failures: Array<{
					id: string;
					query: string;
					expected: string;
					results: string[];
				}> = [];
				for (const evalCase of evals) {
					const results = await search.search(evalCase.query, { limit: 5 });
					const paths = results.map((result) => result.path);
					const rank = paths.indexOf(evalCase.expectedPath);
					if (rank === 0) top1 += 1;
					if (rank >= 0 && rank < 3) top3 += 1;
					if (rank >= 0 && rank < 5) top5 += 1;
					if (rank !== 0) {
						failures.push({
							id: evalCase.id,
							query: evalCase.query,
							expected: evalCase.expectedPath,
							results: paths,
						});
					}
				}

				const total = evals.length;
				console.log(
					`KNOWLEDGE_RETRIEVAL_EVAL total=${total} top1=${top1} top3=${top3} top5=${top5}`,
				);
				if (failures.length > 0) {
					console.log(JSON.stringify({ failures }, null, 2));
				}
				expect(total).toBe(26);
				expect(top1 / total).toBeGreaterThanOrEqual(0.95);
				expect(top3).toBe(total);
				expect(top5).toBe(total);
			} finally {
				await Promise.allSettled([
					knowledgeEmbedder.close(),
					vectors.close(),
					metadata.close(),
				]);
				rmSync(root, { recursive: true, force: true });
			}
		},
		10 * 60_000,
	);
});
