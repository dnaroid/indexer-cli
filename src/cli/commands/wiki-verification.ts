import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import type { KnowledgeVerificationReceipt } from "../../core/types.js";
import type { VerificationPreparationOptions } from "../../knowledge/service.js";
import { withWikiRuntime } from "./wiki-runtime.js";
import { runWikiVerificationChecks } from "./wiki-verification-runner.js";

function fail(error: unknown): void {
	console.error(`Wiki verification failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

async function selectorsFromFile(filePath?: string): Promise<VerificationPreparationOptions> {
	if (!filePath) return {};
	const selectors: unknown = JSON.parse(await readFile(filePath, "utf8"));
	if (!selectors || typeof selectors !== "object" || Array.isArray(selectors)) {
		throw new Error("Selectors must be a JSON object mapping evidence paths to {kind, value}.");
	}
	return { selectors: selectors as VerificationPreparationOptions["selectors"] };
}

export function registerWikiVerificationCommands(wiki: Command): void {
	wiki.command("prepare")
		.description("Prepare current evidence hashes and an unaccepted receipt draft; never verifies")
		.requiredOption("--path <path>", "primary knowledge source")
		.option("--selectors <file>", "optional JSON evidence selector map")
		.option("--output <file>", "write a new receipt draft file (never overwrite)")
		.option("--json", "print the draft as JSON (default)")
		.action(async (options: { path: string; selectors?: string; output?: string }) => {
			try {
				const preparationOptions = await selectorsFromFile(options.selectors);
				await withWikiRuntime(async ({ service }) => {
					const facts = await service.prepareVerification(options.path, preparationOptions);
					const draft = { version: 1, reviewer: "", rationale: "", preparedAt: Date.now(),
						assertionReferences: [], evidenceReferences: [], limitations: [],
						sourcePath: facts.sourcePath, sourceHash: facts.sourceHash, relationsHash: facts.relationsHash,
						inputs: facts.inputs, assertionBindings: [{ path: facts.sourcePath, hash: facts.sourceHash }],
						evidenceBindings: facts.inputs.map((input) => ({ path: input.inputPath, hash: input.inputHash })),
					};
					for (const warning of facts.warnings) console.error(`Warning: ${warning}`);
					const text = `${JSON.stringify(draft, null, 2)}\n`;
					if (options.output) {
						await writeFile(options.output, text, { flag: "wx" });
						console.log(`Receipt draft: ${options.output}. Review source/evidence and fill the attestation before verify.`);
					} else process.stdout.write(text);
				});
			} catch (error) { fail(error); }
		});

	wiki.command("verify")
		.description("Accept an explicitly reviewed, hash-bound verification receipt atomically")
		.requiredOption("--path <path>", "primary knowledge source")
		.requiredOption("--receipt <file>", "reviewed version 1 JSON receipt; external test claims are attestations")
		.option("--check <command>", "explicitly execute a local evidence check (repeatable; receipt commands are never executed)",
			(value: string, previous: string[]) => [...previous, value], [] as string[])
		.option("--json", "print JSON")
		.action(async (options: { path: string; receipt: string; check?: string[]; json?: boolean }) => {
			try {
				const receipt = JSON.parse(await readFile(options.receipt, "utf8")) as KnowledgeVerificationReceipt;
				if (receipt?.locallyRecordedRunnerChecks !== undefined) {
					throw new Error("Imported receipts cannot claim local execution. Remove locallyRecordedRunnerChecks and use --check to run them explicitly.");
				}
				const selectors: NonNullable<VerificationPreparationOptions["selectors"]> = {};
				if (Array.isArray(receipt?.inputs)) {
					for (const input of receipt.inputs) {
						if (input?.selector && typeof input.inputPath === "string") {
							selectors[input.inputPath] = { kind: input.selector.kind, value: input.selector.value };
						}
					}
				}
				await withWikiRuntime(async ({ service, projectRoot }) => {
					const localRunnerChecks = options.check?.length
						? await runWikiVerificationChecks(options.check, projectRoot) : undefined;
					if (localRunnerChecks) receipt.locallyRecordedRunnerChecks = [...localRunnerChecks];
					const entry = await service.verify(options.path, receipt, { selectors, localRunnerChecks });
					const status = await service.getStatus(entry);
					if (options.json) console.log(JSON.stringify(status, null, 2));
					else console.log(`verified ${entry.path}: ${status.status} (declared evidence freshness, not proof of semantics)`);
				});
			} catch (error) { fail(error); }
		});
}
