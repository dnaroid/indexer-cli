import type { Command } from "commander";
import { summarizeKnowledgeCandidates } from "../../knowledge/service.js";
import { candidateReviewRecommendation } from "../format/knowledge.js";
import { withWikiRuntime } from "./wiki-runtime.js";
import { parseWikiSearchMode, withWikiSearch } from "./wiki-search-runtime.js";

export function registerWikiSearchCommand(wiki: Command): void {
	wiki.command("search <query>")
		.description("Retrieve registered knowledge plus default-trusted unreviewed indexed documents")
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
					const defaultTrusted = results.filter((result) =>
						result.authority === "registered" && result.status !== "fresh" && result.trust === "default");
					const explicitlyTrusted = results.filter((result) =>
						result.authority === "registered" && result.status !== "fresh" && result.trust === "explicit");
					if (defaultTrusted.length > 0) {
						console.log(`Warning: ${defaultTrusted.length} registered result${defaultTrusted.length === 1 ? " is" : "s are"} trusted by default but not verified/current; inspect status before relying on ${defaultTrusted.length === 1 ? "it" : "them"}.`);
					}
					if (explicitlyTrusted.length > 0) {
						console.log(`Warning: ${explicitlyTrusted.length} explicitly trusted result${explicitlyTrusted.length === 1 ? " has" : "s have"} stale or absent verification; trust is not verification.`);
					}
					if (results.some((result) => result.authority === "unreviewed-indexed")) {
						console.log("Warning: indexed unclassified documents are trusted by default for retrieval but remain unreviewed; record selected documents only when you need durable primary-spec classification, relations, or verification.");
					}
					if (results.length === 0) console.log("no indexed project knowledge or unreviewed document fallback matched; absence is not proof of no contract");
					for (const result of results) {
						const authority = result.authority === "unreviewed-indexed" ? "unreviewed" : "registered";
						console.log(`${result.score.toFixed(2).padStart(6)} ${authority.padEnd(10)} ${result.status.padEnd(19)} trust=${result.trust.padEnd(10)} ${result.path} — ${result.title}`);
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
