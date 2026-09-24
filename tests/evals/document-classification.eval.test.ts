import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocumentClassifierConfig } from "../../src/knowledge/document-classifier-config.js";
import { buildDocumentClassifierInput, classifyDocumentWithJev } from "../../src/knowledge/document-metadata.js";
import type { DocumentKind, DocumentStatus } from "../../src/knowledge/document-metadata-types.js";

type Case = { path: string; kind: DocumentKind; status?: DocumentStatus };

function hideGroundTruthFrontmatter(content: string): string {
	return content.replace(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$))/, (_all, open: string, body: string, close: string) => {
		const filtered = body.split(/\r?\n/).filter((line: string) => !/^(kind|status)\s*:/i.test(line)).join("\n");
		return `${open}${filtered}${close}`;
	});
}

describe("Jev document classification eval", () => {
	it.skipIf(process.env.RUN_DOCUMENT_CLASSIFIER_EVAL !== "1")("classifies curated project documents without label leakage", async () => {
		const root = path.resolve(__dirname, "../..");
		const cases = JSON.parse(await fs.readFile(path.join(root, "evals/knowledge/document-classification.json"), "utf8")) as Case[];
		const config = loadDocumentClassifierConfig();
		expect(config.apiKey, "OPENROUTER_API_KEY is required for this opt-in eval").toBeTruthy();

		let kindCorrect = 0;
		let statusCorrect = 0;
		let statusTotal = 0;
		const failures: string[] = [];
		for (const item of cases) {
			const raw = await fs.readFile(path.join(root, item.path), "utf8");
			const content = hideGroundTruthFrontmatter(raw);
			const classifierInput = buildDocumentClassifierInput(content);
			expect(classifierInput.length).toBeLessThanOrEqual(20_000);
			const result = await classifyDocumentWithJev(content, config, item.path);
			if (result?.kind === item.kind) kindCorrect++;
			else failures.push(`${item.path}: kind expected=${item.kind} actual=${result?.kind ?? "unavailable"}`);
			if (item.status) {
				statusTotal++;
				if (result?.status === item.status) statusCorrect++;
				else failures.push(`${item.path}: status expected=${item.status} actual=${result?.status ?? "unavailable"}`);
			}
		}
		console.log(`DOCUMENT_CLASSIFIER_EVAL model=${config.model} cases=${cases.length} kind=${kindCorrect}/${cases.length} status=${statusCorrect}/${statusTotal}`);
		if (failures.length) console.log(failures.join("\n"));
		expect(kindCorrect / cases.length).toBeGreaterThanOrEqual(0.8);
		expect(statusCorrect / statusTotal).toBeGreaterThanOrEqual(0.8);
	}, 120_000);
});
