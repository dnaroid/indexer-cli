import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../core/config.js";
import type { KnowledgeDiscoverySignals } from "./discovery.js";

const FORMAT_VERSION = 1;
const MAX_ROWS = 5_000;
const CACHE_FILE = ".indexer-cli/knowledge-discovery-v1.json";
interface Fingerprint { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; }
interface CacheRow { path: string; fingerprint: string; hash: string; title: string; signals: KnowledgeDiscoverySignals; }
interface CacheFile { version: number; projectId: string; config: string; rows: CacheRow[]; }
export interface DiscoveryDocument { hash: string; title: string; signals: KnowledgeDiscoverySignals; }

function fingerprint(value: Fingerprint): string {
	return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}
function configFingerprint(): string {
	const current = config.getAll();
	return createHash("sha256").update(JSON.stringify({ extensions: current.documentExtensions, include: current.documentIncludePaths, exclude: current.documentExcludePaths, maxBytes: current.documentMaxBytes, format: FORMAT_VERSION })).digest("hex");
}

/** Best-effort discovery hints. It never participates in receipt or freshness hashes. */
export class DiscoveryCache {
	private rows = new Map<string, CacheRow>();
	private loaded = false;
	private dirty = false;
	private readonly cachePath: string;
	private readonly config = configFingerprint();
	constructor(private readonly root: string, private readonly projectId: string) { this.cachePath = path.join(root, CACHE_FILE); }

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as CacheFile;
			if (parsed.version !== FORMAT_VERSION || parsed.projectId !== this.projectId || parsed.config !== this.config || !Array.isArray(parsed.rows)) return;
			for (const row of parsed.rows) if (typeof row.path === "string" && !row.path.startsWith("/") && !row.path.split("/").includes("..") && typeof row.fingerprint === "string" && typeof row.hash === "string" && typeof row.title === "string" && typeof row.signals?.score === "number" && ["spec-candidate", "meta-index", "design-reference", "weak-candidate"].includes(row.signals.roleHint) && Array.isArray(row.signals.signals) && row.signals.signals.every((signal) => typeof signal === "string")) this.rows.set(row.path, row);
		} catch { /* Cache corruption and unavailable storage are cache misses. */ }
	}

	async document(filePath: string, analyze: (text: string) => Omit<DiscoveryDocument, "hash">): Promise<DiscoveryDocument | null> {
		await this.load();
		const fullPath = path.join(this.root, filePath);
		let before: Fingerprint;
		try { before = await stat(fullPath, { bigint: true }) as Fingerprint; } catch { return null; }
		const key = fingerprint(before);
		const cached = this.rows.get(filePath);
		if (cached?.fingerprint === key) return { hash: cached.hash, title: cached.title, signals: cached.signals };
		try {
			const bytes = await readFile(fullPath);
			const after = await stat(fullPath, { bigint: true }) as Fingerprint;
			const result = { hash: createHash("sha256").update(bytes).digest("hex"), ...analyze(bytes.toString("utf8")) };
			if (fingerprint(after) === key) { this.rows.set(filePath, { path: filePath, fingerprint: key, ...result }); this.dirty = true; }
			return result;
		} catch { return null; }
	}

	async save(scannedPaths: readonly string[]): Promise<void> {
		if (!this.dirty) return;
		const scanned = new Set(scannedPaths);
		const rows = [...this.rows.values()].filter((row) => scanned.has(row.path)).slice(-MAX_ROWS);
		try {
			await mkdir(path.dirname(this.cachePath), { recursive: true });
			const temporary = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify({ version: FORMAT_VERSION, projectId: this.projectId, config: this.config, rows }), { mode: 0o600 });
			await rename(temporary, this.cachePath);
			this.dirty = false;
		} catch { /* Discovery remains correct without persistence. */ }
	}
}
