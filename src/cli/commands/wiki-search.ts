import type { Command } from "commander";
import { summarizeKnowledgeCandidates } from "../../knowledge/service.js";
import { candidateReviewRecommendation } from "../format/knowledge.js";
import { withWikiRuntime } from "./wiki-runtime.js";
import { parseWikiSearchMode, withWikiSearch } from "./wiki-search-runtime.js";

export function registerWikiSearchCommand(wiki: Command): void {
	wiki.command("search <query>")
		.description("Retrieve authoritative knowledge with lexical or hybrid section search")
		.option("--limit <number>", "maximum knowledge results", "8")
		.option("--mode <mode>", "hybrid, lexical (offline), or semantic", "hybrid")
		.option("--no-refresh", "use the existing completed index without auto-indexing")
		.option("--include-secondary", "include design-only references")
		.option("--path-prefix <path>", "limit document paths")
		.option("--min-score <number>", "minimum final relevance score")
		.option("--json", "emit JSON")
		.action(async (query: string, options: {
			limit?: string; mode?: string; refresh?: boolean; includeSecondary?: boolean;
			pathPrefix?: string; minScore?: string; json?: boolean;
		}) => {
			try {
				const mode = parseWikiSearchMode(options.mode);
				const limit = Number(options.limit ?? "8");
				if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
				const minScore = options.minScore === undefined ? undefined : Number(options.minScore);
				if (minScore !== undefined && !Number.isFinite(minScore)) throw new Error("--min-score must be a number.");
				await withWikiRuntime(async (runtime) => withWikiSearch(runtime, mode, async (engine, initializationWarning) => {
					const [results, candidates] = await Promise.all([
						engine.search(query, { limit, mode, includeSecondary: options.includeSecondary,
							pathPrefix: options.pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, ""), minScore }),
						runtime.service.discover(),
					]);
					const candidateSummary = summarizeKnowledgeCandidates(candidates);
					const recommendation = candidateReviewRecommendation(candidateSummary);
					const diagnostics = { ...engine.getDiagnostics(), initializationWarning, indexWarning: runtime.indexWarning,
						indexRefreshRequested: options.refresh !== false && mode !== "lexical" };
					if (options.json) {
						console.log(JSON.stringify({ query, results, diagnostics, ...candidateSummary, recommendation }, null, 2));
						return;
					}
					if (recommendation) console.log(`Recommendation: ${recommendation}`);
					if (diagnostics.note) console.log(`Retrieval: ${diagnostics.note}`);
					if (initializationWarning) console.error(`Semantic provider unavailable: ${initializationWarning}`);
					if (results.length === 0) console.log("no indexed project knowledge matched; absence is not proof of no contract");
					for (const result of results) {
						console.log(`${result.score.toFixed(2).padStart(6)} ${result.lifecycle.padEnd(10)} ${result.status.padEnd(19)} ${result.path} — ${result.title}`);
						console.log(`       ${result.summary}`);
						console.log(`       why=${result.reasonCodes.slice(0, 6).join(",")}`);
					}
				}), { refresh: options.refresh !== false && mode !== "lexical" });
			} catch (error) {
				console.error(`Wiki search failed: ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			}
		});
}
