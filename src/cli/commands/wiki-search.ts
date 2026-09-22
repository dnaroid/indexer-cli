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
		.option("--verbose", "show retrieval reason codes and discovery review guidance")
		.option("--json", "emit JSON")
		.action(async (query: string, options: {
			limit?: string; mode?: string; refresh?: boolean; includeSecondary?: boolean;
			pathPrefix?: string; minScore?: string; verbose?: boolean; json?: boolean;
		}) => {
			try {
				const mode = parseWikiSearchMode(options.mode);
				const limit = Number(options.limit ?? "8");
				if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
				const minScore = options.minScore === undefined ? undefined : Number(options.minScore);
				if (minScore !== undefined && !Number.isFinite(minScore)) throw new Error("--min-score must be a number.");
				await withWikiRuntime(async (runtime) => withWikiSearch(runtime, mode, async (engine, initializationWarning) => {
					const results = await engine.search(query, { limit, mode, includeSecondary: options.includeSecondary,
						pathPrefix: options.pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, ""), minScore });
					const diagnostics = { ...engine.getDiagnostics(), initializationWarning, indexWarning: runtime.indexWarning,
						indexRefreshRequested: options.refresh !== false && mode !== "lexical" };
					if (options.json) {
						// JSON has always included these discovery fields.
						const candidateSummary = summarizeKnowledgeCandidates(await runtime.service.discover());
						const recommendation = candidateReviewRecommendation(candidateSummary);
						console.log(JSON.stringify({ query, results, diagnostics, ...candidateSummary, recommendation }, null, 2));
						return;
					}
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
						console.log("Warning: indexed unclassified results are default-trusted but unreviewed; inspect before relying on them.");
					}
					if (results.length === 0) console.log("no indexed project knowledge or unreviewed document fallback matched; absence is not proof of no contract");
					for (const result of results) {
						const authority = result.authority === "unreviewed-indexed" ? "unreviewed" : "registered";
						const range = result.bestRanges[0];
						const evidence = range ? `:${range.startLine}-${range.endLine}` : "";
						const summary = options.verbose || result.summary.length <= 160
							? result.summary
							: `${result.summary.slice(0, 159)}…`;
						console.log(`${result.score.toFixed(2)} ${authority} ${result.status} trust=${result.trust} ${result.path}${evidence} — ${summary}`);
						if (options.verbose) {
							console.log(`  title=${result.title || "(untitled)"}`);
							console.log(`  why=${result.reasonCodes.join(",") || "none"}`);
						}
					}
					if (options.verbose) {
						const candidateSummary = summarizeKnowledgeCandidates(await runtime.service.discover());
						const recommendation = candidateReviewRecommendation(candidateSummary);
						if (recommendation) console.log(`Recommendation: ${recommendation}`);
					}
				}), { refresh: options.refresh !== false && mode !== "lexical" });
			} catch (error) {
				console.error(`Wiki search failed: ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			}
		});
}
