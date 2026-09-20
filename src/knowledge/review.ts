import { createHash } from "node:crypto";
import type { KnowledgeImpactResult } from "./impact.js";
import type { KnowledgeReviewObligation, KnowledgeReviewResolution, SqliteKnowledgeReviewStore } from "../storage/knowledge-reviews.js";

export { type KnowledgeReviewObligation, type KnowledgeReviewResolution };
export interface ReviewPathState { path: string; hash: string | null; state: "present" | "deleted" | "unreadable"; }
export interface KnowledgeReviewBinding {
	paths?: string[];
	base: string;
	baseIdentity: string;
}
export interface KnowledgeReviewInput { projectId: string; taskScope: string; impact: KnowledgeImpactResult; pathStates: ReviewPathState[]; contractStates?: Record<string, { sourceHash: string | null; relationsHash: string; evidenceHash?: string }>; binding: KnowledgeReviewBinding; }
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const sorted = (v: string[]) => [...new Set(v)].sort();

/** Turns impact facts into deterministic human-review obligations; it makes no semantic decision. */
export function deriveKnowledgeReviewObligations(input: KnowledgeReviewInput): KnowledgeReviewObligation[] {
	const state = new Map(input.pathStates.map((x) => [x.path, x]));
	const make = (kind: string, paths: string[], contractPath?: string): KnowledgeReviewObligation => {
		const normalized = sorted(paths); const contract = contractPath ? input.contractStates?.[contractPath] : undefined;
		const evidence = { paths: normalized.map((p) => state.get(p) ?? { path:p, hash:null, state:"deleted" }), contractPath, contract: contract ?? null, binding: input.binding };
		const identity = { projectId: input.projectId, taskScope: input.taskScope, kind, contractPath: contractPath ?? null, paths: normalized };
		return { id: digest(identity), projectId: input.projectId, taskScope: input.taskScope, kind, contractPath, paths: normalized, fingerprint: digest({ identity, evidence }), evidence, relevant:true, createdAt:0, updatedAt:0 };
	};
	const out: KnowledgeReviewObligation[] = [];
	for (const affected of input.impact.knownAffected) out.push(make("known-affected-contract", affected.matchedChanges, affected.path));
	for (const p of input.impact.uncoveredPaths) out.push(make("uncovered-path", [p]));
	for (const doc of input.impact.changedDocuments) out.push(make(doc.requiresClassification ? "new-document" : "changed-document", [doc.path], doc.knownClassification ? doc.path : undefined));
	for (const p of input.impact.missingTrackedSpecs) out.push(make("missing-contract", [p], p));
	return out.sort((a,b) => a.id.localeCompare(b.id));
}
export class KnowledgeReviewService {
	constructor(private readonly store: SqliteKnowledgeReviewStore) {}
	async collect(input: KnowledgeReviewInput) { return this.store.reconcile(input.projectId, input.taskScope, deriveKnowledgeReviewObligations(input)); }
	async list(projectId: string, taskScope?: string) { return this.store.list(projectId, { taskScope, relevantOnly:true }); }
	async get(id: string) { return this.store.get(id); }
	async resolve(id: string, expectedFingerprint: string, input: { resolution: KnowledgeReviewResolution; reviewer: string; rationale: string; evidence: string }) { return this.store.resolve(id, expectedFingerprint, input); }
	async check(input: KnowledgeReviewInput) {
		const obligations = await this.collect(input);
		const unresolved = obligations.filter((obligation) => !isKnowledgeReviewResolved(obligation));
		return { obligations, unresolved, ok: unresolved.length === 0 };
	}
}

/** A human escalation is deliberately open until a substantive resolution is recorded. */
export function isKnowledgeReviewResolved(obligation: Pick<KnowledgeReviewObligation, "resolution">): boolean {
	return Boolean(obligation.resolution && obligation.resolution !== "needs-human");
}
