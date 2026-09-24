import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocumentClassifierConfig } from "../../src/knowledge/document-classifier-config.js";
import { classifyDocumentDecisionWithJev } from "../../src/knowledge/document-metadata.js";
import type { DocumentKind, DocumentStatus } from "../../src/knowledge/document-metadata-types.js";

type Case = { id: string; content: string; kind: DocumentKind; status?: DocumentStatus };
type Mode = "semantic" | "strict-blind" | "hard-blind";

const METADATA_HEADING = /^(type|status|lifecycle|тип|статус|жизненный\s+цикл)$/i;
const TAXONOMY_CUE = /(\bspec(?:ification)?s?\b|\bguide(?:s)?\b|\bplan(?:s)?\b|\bproposal(?:s)?\b|\broadmap(?:s)?\b|\barchive(?:d|s)?\b|\baudit(?:s|ed)?\b|\breport(?:s)?\b|\bhistorical\b|\bhistory\b|\bcurrent\b|\bactive\b|\bproposed\b|\bsuperseded\b|\bimplemented\b|\bimplementation\b|спецификац\w*|руководств\w*|гайд\w*|план\w*|предложен\w*|аудит\w*|отч[её]т\w*|архив\w*|историческ\w*|текущ\w*|активн\w*|замен[её]н\w*|реализован\w*|реализац\w*)/giu;

function strictBlind(content: string): string {
	const lines = content.split(/\r?\n/);
	const output: string[] = [];
	let skipLevel = 0;
	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const level = heading[1]!.length;
			if (skipLevel && level <= skipLevel) skipLevel = 0;
			if (!skipLevel && METADATA_HEADING.test(heading[2]!.trim())) {
				skipLevel = level;
				continue;
			}
			if (skipLevel) continue;
		} else if (skipLevel) continue;
		if (/^\s*(status|type|lifecycle|статус|тип|жизненный\s+цикл)\s*:/i.test(line)) continue;
		output.push(line);
	}
	return output.join("\n");
}

function transform(content: string, mode: Mode): string {
	if (mode === "semantic") return content;
	const strict = strictBlind(content);
	return mode === "hard-blind" ? strict.replace(TAXONOMY_CUE, "[redacted]") : strict;
}

describe("Jev anonymized external holdout", () => {
	it.skipIf(process.env.RUN_DOCUMENT_CLASSIFIER_HOLDOUT_EVAL !== "1")("keeps accepted blind classifications precision-first", async () => {
		const root = path.resolve(__dirname, "../..");
		const cases = JSON.parse(await fs.readFile(path.join(root, "evals/knowledge/document-classification-holdout.json"), "utf8")) as Case[];
		const config = loadDocumentClassifierConfig();
		expect(config.apiKey, "OPENROUTER_API_KEY is required for this opt-in eval").toBeTruthy();

		for (const mode of ["semantic", "strict-blind", "hard-blind"] as const) {
			let acceptedKind = 0;
			let correctKind = 0;
			let wrongKind = 0;
			let acceptedStatus = 0;
			let correctStatus = 0;
			let wrongStatus = 0;
			let statusTotal = 0;
			const failures: string[] = [];
			for (const item of cases) {
				const decision = await classifyDocumentDecisionWithJev(transform(item.content, mode), config, `${item.id}.md`);
				expect(decision, `${mode}/${item.id}: classifier unavailable`).toBeTruthy();
				if (!decision) continue;
				if (decision.kind.confidence >= config.kindMinConfidence) {
					acceptedKind++;
					if (decision.kind.choice === item.kind) correctKind++;
					else {
						wrongKind++;
						failures.push(`${item.id}: kind expected=${item.kind} actual=${decision.kind.choice} confidence=${decision.kind.confidence}`);
					}
				}
				if (item.status) {
					statusTotal++;
					if (decision.status.confidence >= config.statusMinConfidence) {
						acceptedStatus++;
						if (decision.status.choice === item.status) correctStatus++;
						else {
							wrongStatus++;
							failures.push(`${item.id}: status expected=${item.status} actual=${decision.status.choice} confidence=${decision.status.confidence}`);
						}
					}
				}
			}
			const kindPrecision = acceptedKind > 0 ? correctKind / acceptedKind : 0;
			const statusPrecision = acceptedStatus > 0 ? correctStatus / acceptedStatus : 0;
			console.log(`DOCUMENT_CLASSIFIER_HOLDOUT mode=${mode} cases=${cases.length} kindAccepted=${acceptedKind} kindWrong=${wrongKind} kindPrecision=${kindPrecision.toFixed(3)} statusAccepted=${acceptedStatus}/${statusTotal} statusWrong=${wrongStatus} statusPrecision=${statusPrecision.toFixed(3)}`);
			if (failures.length) console.log(failures.join("\n"));
			expect(kindPrecision).toBeGreaterThanOrEqual(0.9);
			expect(statusPrecision).toBeGreaterThanOrEqual(0.9);
			expect(acceptedKind / cases.length).toBeGreaterThanOrEqual(0.5);
			expect(acceptedStatus / statusTotal).toBeGreaterThanOrEqual(0.5);
		}
	}, 180_000);
});
