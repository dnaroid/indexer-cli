import type { Command } from "commander";
import { answerAsk, compactAskNotices } from "../../ask/engine.js";
import { createConfiguredAskModel } from "../../ask/configured-model.js";
import { runAskAction } from "../../ask/runner.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

export function registerAskCommand(program: Command): void {
	program.command("ask <question>")
		.description("Investigate a repository question and produce an evidence-cited answer")
		.option("--budget <tokens>", "desired maximum output tokens per model turn (200..20000)", "2000")
		.action(async (question: string, options: { budget: string }) => {
			try {
				const budget = Number(options.budget);
				if (!Number.isSafeInteger(budget) || budget < 200 || budget > 20_000) throw new Error("--budget must be an integer from 200 to 20000");
				const { projectRoot, notice } = resolveInitializedProjectRoot();
				const entry = process.argv[1];
				if (!entry) throw new Error("Cannot locate idx entry point");
				const modelNotices: string[] = [];
				const result = await answerAsk({
					question, projectRoot, budget,
					model: createConfiguredAskModel(message => modelNotices.push(message)),
					run: (action, timeout) => runAskAction(projectRoot, entry, action, timeout),
				});
				const notices = compactAskNotices([...(notice ? [notice] : []), ...result.notices, ...modelNotices]);
				process.stdout.write(`${result.text}${notices.length ? `\n\nMandatory notices:\n${notices.join("\n")}` : ""}\n`);
				if (result.failed) process.exitCode = 1;
			} catch (error) {
				console.error(`ask: ${error instanceof Error ? error.message : "request failed"}`);
				process.exitCode = 1;
			}
		});
}
