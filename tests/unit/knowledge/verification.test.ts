import { describe, expect, it } from "vitest";
import { validateLocallyExecutedVerificationReceipt, validateVerificationReceipt } from "../../../src/knowledge/verification/evidence.js";
import { resolveVerificationSelector } from "../../../src/knowledge/verification/selectors.js";
import { runVerificationChecks } from "../../../src/knowledge/verification/runner.js";

const source = "a".repeat(64); const relations = "b".repeat(64); const input = "c".repeat(64);
const facts = { sourcePath: "docs/a.md", sourceHash: source, relationsHash: relations, inputs: [{ inputPath: "src/a.ts", inputHash: input }] };
const receipt = () => ({ version: 1 as const, ...facts, preparedAt: 1, reviewer: "reviewer", rationale: "Reviewed implementation", assertionReferences: ["claim"], evidenceReferences: ["read:src/a.ts"], assertionBindings: [{ path: "docs/a.md", hash: source, range: { startLine: 1, endLine: 1 } }], evidenceBindings: [{ path: "src/a.ts", hash: input }], limitations: [] });

describe("verification receipt validation", () => {
	it("rejects forged or stale bindings and failed attestations", () => {
		expect(() => validateVerificationReceipt({ ...receipt(), sourceHash: "forged" }, facts)).toThrow("stale");
		expect(() => validateVerificationReceipt({ ...receipt(), attestedRunnerChecks: [{ command: "npm test", resultHash: "x", exitCode: 1, complete: true, recordedBy: "attested" }] }, facts)).toThrow("successful");
	});

	it("requires an explicit zero-input limitation", () => {
		const zero = { ...facts, inputs: [] };
		expect(() => validateVerificationReceipt({ ...receipt(), ...zero }, zero)).toThrow("Zero tracked");
	 expect(() => validateVerificationReceipt({ ...receipt(), ...zero, assertionBindings: [{ path: "docs/a.md", hash: source }], evidenceBindings: [{ path: "docs/a.md", hash: source }], limitations: ["No code inputs."], zeroTrackedInputsAcknowledged: true }, zero)).not.toThrow();
	});

	it("fingerprints safe selectors and rejects uncertainty", () => {
		expect(resolveVerificationSelector('{"a":{"b":1}}', "json-pointer", "/a/b").fingerprint).toHaveLength(64);
		expect(() => resolveVerificationSelector("# Same\nA\n# Same\nB", "document-section", "Same")).toThrow("ambiguous");
		expect(() => resolveVerificationSelector("export const other = 1", "code-symbol", "missing")).toThrow("missing");
	});

	it("rejects unknown fields and forged local execution", () => {
		expect(() => validateVerificationReceipt({ ...receipt(), locallyRecordedRunnerChecks: [] }, facts)).toThrow("cannot claim");
		expect(() => validateVerificationReceipt({ ...receipt(), surprise: true }, facts)).toThrow("unknown fields");
		expect(() => validateVerificationReceipt({ ...receipt(), evidenceBindings: [{ path: "src/a.ts", hash: "d".repeat(64) }] }, facts)).toThrow("does not match");
	});

	it("fingerprints a full symbol body rather than only its declaration", () => {
		const one = resolveVerificationSelector("export function work() { return 1; }", "code-symbol", "work");
		const two = resolveVerificationSelector("export function work() { return 2; }", "code-symbol", "work");
		expect(one.fingerprint).not.toBe(two.fingerprint);
	});

	it("marks only runner-produced arrays as local execution", async () => {
		const checks = await runVerificationChecks(["test"], async () => ({ exitCode: 0, output: "ok" }));
		expect(checks).toEqual([expect.objectContaining({ recordedBy: "local-runner" })]);
		expect(() => validateVerificationReceipt({ ...receipt(), locallyRecordedRunnerChecks: checks }, facts)).toThrow("cannot claim");
	});

	it("never ignores supplied failed local checks when a receipt omits them", async () => {
		const checks = await runVerificationChecks(["test"], async () => ({ exitCode: 1, output: "failed" }));
		expect(() => validateLocallyExecutedVerificationReceipt(receipt(), facts, checks)).toThrow("must include");
		expect(() => validateLocallyExecutedVerificationReceipt({ ...receipt(), locallyRecordedRunnerChecks: checks }, facts, checks)).toThrow("successful");
	});
});
