import type { KnowledgeVerificationEvidenceBinding, KnowledgeVerificationReceipt, LocalVerificationRunnerChecks } from "../../core/types.js";
import { isTrustedLocalRunnerChecks } from "./runner.js";

export type VerificationFacts = Pick<KnowledgeVerificationReceipt, "sourcePath" | "sourceHash" | "relationsHash" | "inputs">;

const receiptFields = new Set([
	"version", "sourcePath", "sourceHash", "relationsHash", "inputs", "preparedAt", "reviewer", "rationale",
	"assertionReferences", "evidenceReferences", "assertionBindings", "evidenceBindings", "limitations",
	"zeroTrackedInputsAcknowledged", "attestedRunnerChecks", "locallyRecordedRunnerChecks",
]);
const hash = /^[a-f0-9]{64}$/;
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}
function nonemptyStrings(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`${label} must be a non-empty array of strings.`);
}
function bindings(value: unknown, label: string): asserts value is KnowledgeVerificationEvidenceBinding[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty.`);
	for (const binding of value) {
		const b = object(binding, label);
		if (!Object.keys(b).every((key) => ["path", "hash", "range", "assertion"].includes(key)) || typeof b.path !== "string" || !b.path.trim() || typeof b.hash !== "string" || !hash.test(b.hash)) throw new Error(`${label} contains an invalid path or hash.`);
		if (b.assertion !== undefined && (typeof b.assertion !== "string" || !b.assertion.trim())) throw new Error(`${label} contains an invalid assertion.`);
		if (b.range !== undefined) {
			const r = object(b.range, `${label}.range`);
			if (!Object.keys(r).every((key) => key === "startLine" || key === "endLine") || !Number.isInteger(r.startLine) || !Number.isInteger(r.endLine) || (r.startLine as number) < 1 || (r.endLine as number) < (r.startLine as number)) throw new Error(`${label} contains an invalid range.`);
		}
	}
}

function inputs(value: unknown): asserts value is KnowledgeVerificationReceipt["inputs"] {
	if (!Array.isArray(value)) throw new Error("Verification receipt inputs must be an array.");
	for (const input of value) {
		const i = object(input, "Verification receipt input");
		if (!Object.keys(i).every((key) => key === "inputPath" || key === "inputHash" || key === "selector") || typeof i.inputPath !== "string" || !i.inputPath.trim() || typeof i.inputHash !== "string" || !hash.test(i.inputHash)) throw new Error("Verification receipt input is invalid.");
		if (i.selector !== undefined) {
			const selector = object(i.selector, "Verification receipt selector");
			if (!Object.keys(selector).every((key) => key === "kind" || key === "value" || key === "fingerprint") || !["code-symbol", "json-pointer", "document-section"].includes(selector.kind as string) || typeof selector.value !== "string" || !selector.value.trim() || typeof selector.fingerprint !== "string" || !hash.test(selector.fingerprint)) throw new Error("Verification receipt selector is invalid.");
		}
	}
}

/** Validates untrusted JSON and exact deterministic binding. Imported receipts never claim local execution. */
export function validateVerificationReceipt(receipt: unknown, facts: VerificationFacts): asserts receipt is KnowledgeVerificationReceipt {
	const r = object(receipt, "Verification receipt");
	if (!Object.keys(r).every((key) => receiptFields.has(key))) throw new Error("Verification receipt contains unknown fields.");
	if (r.version !== 1 || typeof r.sourcePath !== "string" || !r.sourcePath.trim() || typeof r.sourceHash !== "string" || typeof r.relationsHash !== "string") throw new Error("A version 1 verification receipt is required.");
	if (!Number.isFinite(r.preparedAt) || (r.preparedAt as number) <= 0) throw new Error("Verification receipt requires a valid preparedAt timestamp.");
	if (typeof r.reviewer !== "string" || !r.reviewer.trim() || typeof r.rationale !== "string" || !r.rationale.trim()) throw new Error("Verification receipt requires reviewer and rationale.");
	nonemptyStrings(r.assertionReferences, "assertionReferences"); nonemptyStrings(r.evidenceReferences, "evidenceReferences");
	if (!Array.isArray(r.limitations) || r.limitations.some((x) => typeof x !== "string" || !x.trim())) throw new Error("limitations must be an array of strings.");
	bindings(r.assertionBindings, "assertionBindings"); bindings(r.evidenceBindings, "evidenceBindings");
	if (r.sourcePath !== facts.sourcePath || r.sourceHash !== facts.sourceHash || r.relationsHash !== facts.relationsHash) throw new Error("Verification receipt is stale for the source or relation map.");
	if (!hash.test(r.sourceHash) || !hash.test(r.relationsHash)) throw new Error("Verification receipt hashes must be SHA-256 values.");
	inputs(r.inputs);
	const canonical = (inputs: typeof facts.inputs) => JSON.stringify([...inputs].sort((a, b) => a.inputPath.localeCompare(b.inputPath)));
	if (canonical(r.inputs as typeof facts.inputs) !== canonical(facts.inputs)) throw new Error("Verification receipt does not bind the exact current tracked inputs.");
	if (facts.inputs.length === 0 && (r.zeroTrackedInputsAcknowledged !== true || (r.limitations as string[]).length === 0)) throw new Error("Zero tracked inputs require an explicit receipt acknowledgment and limitation.");
	if (facts.inputs.length > 0 && r.zeroTrackedInputsAcknowledged !== undefined) throw new Error("Zero tracked input acknowledgment is only valid with zero inputs.");
	const allowedEvidence = new Map([[facts.sourcePath, facts.sourceHash], ...facts.inputs.map((input) => [input.inputPath, input.inputHash] as const)]);
	for (const binding of r.assertionBindings as KnowledgeVerificationEvidenceBinding[]) {
		if (binding.path !== facts.sourcePath || binding.hash !== facts.sourceHash) throw new Error("Assertion binding must bind the prepared source.");
	}
	for (const binding of [...(r.assertionBindings as KnowledgeVerificationEvidenceBinding[]), ...(r.evidenceBindings as KnowledgeVerificationEvidenceBinding[])]) {
		if (allowedEvidence.get(binding.path) !== binding.hash) throw new Error("Evidence binding does not match a prepared source or tracked input.");
	}
	if (r.locallyRecordedRunnerChecks !== undefined) throw new Error("Imported receipts cannot claim locally recorded runner checks.");
	if (r.attestedRunnerChecks !== undefined) {
		if (!Array.isArray(r.attestedRunnerChecks)) throw new Error("attestedRunnerChecks must be an array.");
		for (const check of r.attestedRunnerChecks) {
			const c = object(check, "runner check");
			if (!Object.keys(c).every((key) => ["command", "resultHash", "logHash", "exitCode", "complete", "recordedBy"].includes(key)) || c.recordedBy !== "attested" || typeof c.command !== "string" || !c.command.trim() || typeof c.resultHash !== "string" || !hash.test(c.resultHash) || (c.logHash !== undefined && (typeof c.logHash !== "string" || !hash.test(c.logHash))) || c.complete !== true || !Number.isInteger(c.exitCode) || c.exitCode !== 0) throw new Error("Verification runner check must be complete and successful.");
		}
	}
}

/** Validates a receipt whose local checks were separately proven in-memory. */
export function validateLocallyExecutedVerificationReceipt(
	receipt: unknown,
	facts: VerificationFacts,
	checks: LocalVerificationRunnerChecks,
): asserts receipt is KnowledgeVerificationReceipt {
	if (!isTrustedLocalRunnerChecks(checks)) throw new Error("Local runner checks must be returned by runVerificationChecks in this process.");
	const r = object(receipt, "Verification receipt");
	if (r.locallyRecordedRunnerChecks === undefined) {
		throw new Error("Receipt must include this process's local runner checks.");
	}
	if (JSON.stringify(r.locallyRecordedRunnerChecks) !== JSON.stringify(checks)) throw new Error("Receipt local runner checks do not match this process's execution.");
	const imported = { ...r };
	delete imported.locallyRecordedRunnerChecks;
	validateVerificationReceipt(imported, facts);
	for (const check of checks) {
		if (check.recordedBy !== "local-runner" || !check.complete || check.exitCode !== 0 || !hash.test(check.resultHash) || (check.logHash !== undefined && !hash.test(check.logHash))) {
			throw new Error("Locally recorded runner check must be complete and successful.");
		}
	}
}
