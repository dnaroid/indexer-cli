import { describe, expect, it } from "vitest";
import {
	documentTitle,
	knowledgeDiscoverySignals,
} from "../../../src/knowledge/discovery.js";

describe("knowledge discovery", () => {
	it("recognizes behavioral contracts independently of folder layout", () => {
		const result = knowledgeDiscoverySignals(
			"docs/payment-behavior.md",
			"# Payment behavior\n\n## Behavior\nDuplicate capture is idempotent.\n\n## Verification\nTest exact replay.\n",
		);
		expect(result.roleHint).toBe("spec-candidate");
		expect(result.score).toBeGreaterThanOrEqual(4);
	});

	it("identifies meta indexes and penalizes fixture/skill resources", () => {
		const meta = knowledgeDiscoverySignals(
			"docs/overview.md",
			"# Specs index\n\nDocumentation index for the specs.\n\n[a](a.md) [b](b.md) [c](c.md) [d](d.md)\n",
		);
		expect(meta.roleHint).toBe("meta-index");

		const fixture = knowledgeDiscoverySignals(
			"skills/demo/evals/session-contract.md",
			"# Session contract\n\n## Behavior\nRetry once.\n",
		);
		expect(fixture.roleHint).toBe("weak-candidate");
		expect(fixture.signals).toContain("fixture-like-path");
	});

	it("recognizes design references without promoting them to primary specs", () => {
		const result = knowledgeDiscoverySignals(
			"architecture/adr-012-design.md",
			"# ADR 012\n\nWe compare two storage designs and record the decision.\n",
		);
		expect(result.roleHint).toBe("design-reference");
	});

	it("extracts a useful title or falls back to the filename", () => {
		expect(documentTitle("# Current contract\ntext", "docs/x.md")).toBe(
			"Current contract",
		);
		expect(documentTitle("plain text", "docs/session-refresh.md")).toBe(
			"session refresh",
		);
	});
});

