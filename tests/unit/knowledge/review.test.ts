import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeReviewService } from "../../../src/knowledge/review.js";
import { collectReviewPathStates } from "../../../src/cli/commands/wiki-review.js";
import { SqliteKnowledgeReviewStore } from "../../../src/storage/knowledge-reviews.js";

const impact = (overrides: Record<string, unknown> = {}) => ({ source:"explicit" as const, changes:{added:[],modified:["src/a.ts"],deleted:[]}, changedPaths:["src/a.ts"], knownAffected:[{path:"docs/contract.md", matchedChanges:["src/a.ts"], status:"fresh", reasons:[]}], uncoveredPaths:[], changedDocuments:[], missingTrackedSpecs:[], graphContext:[], semanticCandidates:[], semanticSweepRequired:true, reasons:[], ...overrides });
const input = (hash = "one", scope = "task", baseIdentity = "base-one") => ({ projectId:"p", taskScope:scope, impact:impact(), pathStates:[{path:"src/a.ts",hash,state:"present" as const}], contractStates:{"docs/contract.md":{sourceHash:"contract",relationsHash:"relations"}}, binding:{base:"HEAD",baseIdentity} });

describe("knowledge review obligations", () => {
	it("is idempotent, requires explanation, reopens changed hashes, and survives reopen", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "review-")); const db = path.join(dir, "db.sqlite");
		let store = new SqliteKnowledgeReviewStore(db); let service = new KnowledgeReviewService(store);
		const [first] = await service.collect(input()); const [again] = await service.collect(input()); expect(again.id).toBe(first.id);
		await expect(service.resolve(first.id, first.fingerprint, { resolution:"no-impact", reviewer:"", rationale:"why", evidence:"proof" })).rejects.toThrow("required");
		await service.resolve(first.id, first.fingerprint, { resolution:"no-impact", reviewer:"r", rationale:"reviewed", evidence:"diff" });
		expect((await service.check(input())).ok).toBe(true);
		expect((await service.check(input("two"))).ok).toBe(false);
		await store.close(); store = new SqliteKnowledgeReviewStore(db); service = new KnowledgeReviewService(store);
		expect((await service.list("p", "task")).length).toBe(1); await store.close();
	});
	it("keeps needs-human open and rejects a resolution after a late edit", async () => {
		const store = new SqliteKnowledgeReviewStore(":memory:"); const service = new KnowledgeReviewService(store);
		const [first] = await service.collect(input());
		await service.resolve(first.id, first.fingerprint, { resolution:"needs-human", reviewer:"r", rationale:"blocked", evidence:"investigate" });
		expect((await service.check(input())).ok).toBe(false);
		await service.collect(input("late-edit"));
		await expect(service.resolve(first.id, first.fingerprint, { resolution:"no-impact", reviewer:"r", rationale:"reviewed", evidence:"diff" })).rejects.toThrow("no longer current");
		await store.close();
	});
	it("reopens an otherwise identical current file when its base changes", async () => {
		const store = new SqliteKnowledgeReviewStore(":memory:"); const service = new KnowledgeReviewService(store);
		const [first] = await service.collect(input("same", "task", "base-one"));
		await service.resolve(first.id, first.fingerprint, { resolution:"no-impact", reviewer:"r", rationale:"reviewed", evidence:"diff" });
		expect((await service.check(input("same", "task", "base-two"))).ok).toBe(false);
		await store.close();
	});
	it("fails safe for escaped and external-symlink paths while hashing binary bytes", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "review-files-"));
		const outside = path.join(tmpdir(), `review-outside-${Date.now()}`);
		await writeFile(path.join(root, "binary.bin"), Buffer.from([0xff, 0x00, 0xfe]));
		await writeFile(outside, "outside");
		await symlink(outside, path.join(root, "outside-link"));
		const result = await collectReviewPathStates(root, impact({ changedPaths:["binary.bin", "../escape", "outside-link"] }));
		expect(result.map((item) => item.state)).toEqual(["present", "unreadable", "unreadable"]);
		expect(result[0].hash).not.toBeNull();
	});
	it("keeps scopes separate and records deletion/rename facts", async () => {
		const store = new SqliteKnowledgeReviewStore(":memory:"); const service = new KnowledgeReviewService(store);
		await service.collect(input("x", "one")); await service.collect(input("x", "two"));
		expect((await service.list("p", "one")).length).toBe(1);
		const result = await service.collect({ ...input("gone"), impact:impact({ changes:{added:[],modified:[],deleted:["docs/contract.md"]}, changedPaths:["docs/contract.md"], knownAffected:[], missingTrackedSpecs:["docs/contract.md"] }), pathStates:[{path:"docs/contract.md",hash:null,state:"deleted"}] });
		expect(result[0].kind).toBe("missing-contract"); expect(result[0].evidence.paths[0]).toMatchObject({state:"deleted"}); await store.close();
	});
	it("treats a rename as both a missing tracked contract and a new document", async () => {
		const store = new SqliteKnowledgeReviewStore(":memory:"); const service = new KnowledgeReviewService(store);
		const result = await service.collect({ ...input(), impact:impact({ changes:{added:["docs/new.md"],modified:[],deleted:["docs/old.md"]}, changedPaths:["docs/new.md","docs/old.md"], knownAffected:[], missingTrackedSpecs:["docs/old.md"], changedDocuments:[{path:"docs/new.md",title:"New",score:1,roleHint:"spec",signals:[],currentHash:"new",requiresClassification:true,requiresReclassification:false}] }), pathStates:[{path:"docs/new.md",hash:"new",state:"present"},{path:"docs/old.md",hash:null,state:"deleted"}] });
		expect(result.map((x) => x.kind).sort()).toEqual(["missing-contract", "new-document"]); await store.close();
	});
});
