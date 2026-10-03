import type { Command } from "commander";
import path from "node:path";
import { config } from "../../core/config.js";
import { acknowledgeKnowledgeReviews, knowledgeReviewStatus } from "../../knowledge/review-state.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

function loadProject(): string {
	const { projectRoot } = resolveInitializedProjectRoot();
	config.load(path.join(projectRoot, ".indexer-cli"));
	return projectRoot;
}
function failure(error: unknown): void {
	const message = (error instanceof Error ? error.message : "Knowledge review failed").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
	console.error(`Knowledge review failed: ${message}`);
	process.exitCode = 2;
}
export function registerKnowledgeCommand(program: Command): void {
	const knowledge = program.command("knowledge").description("Offline spec review monitoring (no index or provider access)");
	knowledge.command("dirty")
		.description("Print yes/no for knowledge dirtiness in the current project")
		.action(async () => {
			try {
				const report = await knowledgeReviewStatus(loadProject());
				console.log(report.status === "clean" ? "no" : "yes");
				process.exitCode = 0;
				if (report.status === "error") {
					const details = report.specs.filter(row => row.status === "error")
						.map(row => `${row.path}: ${row.reasons.join(", ")}`);
					failure(new Error(`Knowledge check incomplete: ${[...details, ...report.warnings].join("; ")}`));
				}
			} catch (error) {
				console.log("yes");
				failure(error);
			}
		});
	knowledge.command("acknowledge <spec-paths...>")
		.description("Explicitly attest that these specs were compared with current implementation/tests")
		.action(async (paths: string[]) => {
			try {
				const acknowledged = await acknowledgeKnowledgeReviews(loadProject(), paths);
				console.log(`Acknowledged: ${acknowledged.join(", ")}`);
			} catch (error) { failure(error); }
		});
}
