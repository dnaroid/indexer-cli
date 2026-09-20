import Database from "better-sqlite3";

export type KnowledgeReviewResolution =
	| "updated-contract"
	| "new-contract"
	| "relations-updated"
	| "no-impact"
	| "needs-human";

export interface KnowledgeReviewObligation {
	id: string;
	projectId: string;
	taskScope: string;
	kind: string;
	contractPath?: string;
	paths: string[];
	fingerprint: string;
	evidence: Record<string, unknown>;
	relevant: boolean;
	resolution?: KnowledgeReviewResolution;
	reviewer?: string;
	rationale?: string;
	resolutionEvidence?: string;
	resolvedAt?: number;
	createdAt: number;
	updatedAt: number;
}

type Row = {
	id: string; project_id: string; task_scope: string; kind: string; contract_path: string | null;
	paths_json: string; fingerprint: string; evidence_json: string; relevant: number;
	resolution: KnowledgeReviewResolution | null; reviewer: string | null;
	rationale: string | null; resolution_evidence: string | null; resolved_at: number | null; created_at: number; updated_at: number;
};

/** Separate durable store: intentionally has no snapshot foreign keys. */
export class SqliteKnowledgeReviewStore {
	private readonly db: Database.Database;
	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_review_obligations (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_scope TEXT NOT NULL,
			kind TEXT NOT NULL, contract_path TEXT, paths_json TEXT NOT NULL,
			fingerprint TEXT NOT NULL, evidence_json TEXT NOT NULL, relevant INTEGER NOT NULL,
			resolution TEXT, reviewer TEXT, rationale TEXT, resolution_evidence TEXT,
			resolved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_knowledge_review_project_scope
			ON knowledge_review_obligations(project_id, task_scope, relevant);`);
	}
	async close(): Promise<void> { this.db.close(); }
	async reconcile(projectId: string, taskScope: string, obligations: KnowledgeReviewObligation[]): Promise<KnowledgeReviewObligation[]> {
		const now = Date.now();
		const tx = this.db.transaction(() => {
			this.db.prepare("UPDATE knowledge_review_obligations SET relevant = 0, updated_at = ? WHERE project_id = ? AND task_scope = ?").run(now, projectId, taskScope);
			const previous = this.db.prepare("SELECT * FROM knowledge_review_obligations WHERE id = ?");
			const write = this.db.prepare(`INSERT INTO knowledge_review_obligations
			(id,project_id,task_scope,kind,contract_path,paths_json,fingerprint,evidence_json,relevant,resolution,reviewer,rationale,resolution_evidence,resolved_at,created_at,updated_at)
			VALUES (@id,@projectId,@taskScope,@kind,@contractPath,@paths,@fingerprint,@evidence,1,@resolution,@reviewer,@rationale,@resolutionEvidence,@resolvedAt,@createdAt,@updatedAt)
			ON CONFLICT(id) DO UPDATE SET paths_json=excluded.paths_json,fingerprint=excluded.fingerprint,evidence_json=excluded.evidence_json,relevant=1,resolution=excluded.resolution,reviewer=excluded.reviewer,rationale=excluded.rationale,resolution_evidence=excluded.resolution_evidence,resolved_at=excluded.resolved_at,updated_at=excluded.updated_at`);
			for (const item of obligations) {
				const old = previous.get(item.id) as Row | undefined;
				const reusable = old?.fingerprint === item.fingerprint;
				write.run({ ...item, contractPath: item.contractPath ?? null, paths: JSON.stringify(item.paths), evidence: JSON.stringify(item.evidence), resolution: reusable ? old?.resolution ?? null : null, reviewer: reusable ? old?.reviewer ?? null : null, rationale: reusable ? old?.rationale ?? null : null, resolutionEvidence: reusable ? old?.resolution_evidence ?? null : null, resolvedAt: reusable ? old?.resolved_at ?? null : null, createdAt: old?.created_at ?? now, updatedAt: now });
			}
		}); tx();
		return this.list(projectId, { taskScope, relevantOnly: true });
	}
	async list(projectId: string, options: { taskScope?: string; relevantOnly?: boolean } = {}): Promise<KnowledgeReviewObligation[]> {
		let sql = "SELECT * FROM knowledge_review_obligations WHERE project_id = ?"; const p: string[] = [projectId];
		if (options.taskScope) { sql += " AND task_scope = ?"; p.push(options.taskScope); }
		if (options.relevantOnly !== false) sql += " AND relevant = 1";
		sql += " ORDER BY task_scope, contract_path, kind, id";
		return (this.db.prepare(sql).all(...p) as Row[]).map((r) => this.map(r));
	}
	async get(id: string): Promise<KnowledgeReviewObligation | undefined> {
		const row = this.db.prepare("SELECT * FROM knowledge_review_obligations WHERE id=?").get(id) as Row | undefined;
		return row ? this.map(row) : undefined;
	}
	async resolve(id: string, expectedFingerprint: string, input: { resolution: KnowledgeReviewResolution; reviewer: string; rationale: string; evidence: string }): Promise<KnowledgeReviewObligation> {
		if (!input.reviewer.trim() || !input.rationale.trim() || !input.evidence.trim()) throw new Error("reviewer, rationale, and evidence are required to resolve a review obligation.");
		const changed = this.db.prepare("UPDATE knowledge_review_obligations SET resolution=?, reviewer=?, rationale=?, resolution_evidence=?, resolved_at=?, updated_at=? WHERE id=? AND relevant=1 AND fingerprint=?").run(input.resolution, input.reviewer.trim(), input.rationale.trim(), input.evidence.trim(), Date.now(), Date.now(), id, expectedFingerprint);
		if (!changed.changes) throw new Error(`Review obligation is no longer current: ${id}. Recollect and review the current change set.`);
		return this.map(this.db.prepare("SELECT * FROM knowledge_review_obligations WHERE id=?").get(id) as Row);
	}
	private map(r: Row): KnowledgeReviewObligation { return { id:r.id, projectId:r.project_id, taskScope:r.task_scope, kind:r.kind, contractPath:r.contract_path ?? undefined, paths:JSON.parse(r.paths_json), fingerprint:r.fingerprint, evidence:JSON.parse(r.evidence_json), relevant:Boolean(r.relevant), resolution:r.resolution ?? undefined, reviewer:r.reviewer ?? undefined, rationale:r.rationale ?? undefined, resolutionEvidence:r.resolution_evidence ?? undefined, resolvedAt:r.resolved_at ?? undefined, createdAt:r.created_at, updatedAt:r.updated_at }; }
}
