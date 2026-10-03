import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../core/config.js";
import { scanProjectDocuments } from "./document-scanner.js";
import { parseDocumentMetadata } from "./document-metadata.js";

const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
type FileHashes = Record<string, string>;
interface Receipt { version: 1; spec: string; reviewedAt: string; files: FileHashes }
export interface KnowledgeReviewRow {
	path: string;
	status: "clean" | "dirty" | "error";
	reasons: string[];
	changedPaths: string[];
	reviewedAt?: string;
}
export interface KnowledgeReviewReport {
	status: "clean" | "dirty" | "error";
	counts: { clean: number; dirty: number; error: number };
	specs: KnowledgeReviewRow[];
	warnings: string[];
}

function relativePath(input: string): string {
	const normalized = path.posix.normalize(input.replace(/\\/g, "/")).replace(/\/+$/, "");
	if (!input.trim() || /[\x00-\x1f\x7f]/.test(input) || /^(?:[\\/]|[A-Za-z]:|~)/.test(input) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`Expected a project-relative path: ${input}`);
	}
	if (normalized.split("/").some(part => part === ".git" || part === ".indexer-cli")) throw new Error(`Internal state cannot be a review dependency: ${input}`);
	return normalized;
}

async function insidePath(root: string, relative: string): Promise<string> {
	const absolute = await realpath(path.join(root, relative));
	const resolved = path.relative(root, absolute);
	if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error(`Path escapes project root: ${relative}`);
	return absolute;
}

/** Content hashes, shared within an invocation; no Git, index, classifier or provider. */
class ReviewCollector {
	private hashes = new Map<string, Promise<string>>();
	constructor(private root: string) {}
	async collect(spec: string): Promise<FileHashes> {
		const specPath = await insidePath(this.root, spec);
		if ((await stat(specPath)).size > config.get("documentMaxBytes")) throw new Error(`Spec exceeds document size limit: ${spec}`);
		const content = await readFile(specPath);
		const metadata = parseDocumentMetadata(content.toString("utf8"), spec);
		if (metadata.kind !== "spec" || metadata.status !== "active" || metadata.warnings.length) throw new Error(`Expected valid explicit kind: spec / status: active: ${spec}`);
		const refs = metadata.references.filter(ref => ref.role !== "mention");
		if (!refs.length) throw new Error(`No Implementation/Tests declarations: ${spec}`);
		const files: FileHashes = Object.create(null);
		files[spec] = hash(content);
		for (const ref of refs) await this.collectPath(relativePath(ref.path), files);
		return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
	}
	private async collectPath(relative: string, files: FileHashes): Promise<void> {
		const absolute = await insidePath(this.root, relative);
		if ((await lstat(path.join(this.root, relative))).isSymbolicLink()) throw new Error(`Symlink dependency is unsupported: ${relative}`);
		const info = await stat(absolute);
		if (info.isDirectory()) {
			// Track directory existence and membership, including empty directories.
			files[`${relative}/`] = hash("directory");
			for (const name of (await readdir(absolute)).sort()) {
				if (name === ".git" || name === ".indexer-cli") continue;
				await this.collectPath(`${relative}/${name}`, files);
			}
		} else if (info.isFile()) {
			let pending = this.hashes.get(relative);
			if (!pending) {
				pending = readFile(absolute).then(hash);
				this.hashes.set(relative, pending);
			}
			files[relative] = await pending;
		} else throw new Error(`Not a regular file or directory: ${relative}`);
	}
}

function receiptPath(root: string, spec: string): string {
	return path.join(root, ".indexer-cli", "knowledge-reviews", `${hash(spec)}.json`);
}

async function readReceipt(root: string, spec: string): Promise<Receipt | undefined> {
	let content: string;
	try { content = await readFile(receiptPath(root, spec), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	const row = JSON.parse(content) as Receipt;
	if (!row || row.version !== 1 || row.spec !== spec || typeof row.reviewedAt !== "string" || !Number.isFinite(Date.parse(row.reviewedAt)) || !row.files || typeof row.files !== "object" || Array.isArray(row.files) || !Object.hasOwn(row.files, spec) || !Object.values(row.files).every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error(`Invalid review receipt: ${spec}`);
	return row;
}

export async function knowledgeReviewStatus(rootPath: string): Promise<KnowledgeReviewReport> {
	const root = await realpath(rootPath);
	const warnings: string[] = [];
	const documents = await scanProjectDocuments(root, { onWarning: warning => warnings.push(`${warning.path}: ${warning.message}`) });
	const collector = new ReviewCollector(root);
	const specs: KnowledgeReviewRow[] = [];
	for (const spec of documents) {
		try {
			const absolute = await insidePath(root, spec);
			if ((await stat(absolute)).size > config.get("documentMaxBytes")) { warnings.push(`${spec}: exceeds document size limit; not inspected`); continue; }
			const metadata = parseDocumentMetadata(await readFile(absolute, "utf8"), spec);
			if (metadata.kind !== "spec" || metadata.status !== "active") continue;
			if (!metadata.references.some(ref => ref.role !== "mention")) {
				specs.push({ path: spec, status: "dirty", reasons: ["no-declarations"], changedPaths: [] });
				continue;
			}
			const files = await collector.collect(spec);
			const receipt = await readReceipt(root, spec);
			const changedPaths = receipt ? [...new Set([...Object.keys(files), ...Object.keys(receipt.files)])].filter(file => files[file] !== receipt.files[file]).sort() : Object.keys(files);
			const reasons: string[] = [];
			if (!receipt) reasons.push("never-reviewed");
			else if (changedPaths.length) reasons.push("content-changed");
			specs.push({ path: spec, status: reasons.length ? "dirty" : "clean", reasons, changedPaths, ...(receipt ? { reviewedAt: receipt.reviewedAt } : {}) });
		} catch (error) {
			specs.push({ path: spec, status: "error", reasons: [error instanceof Error ? error.message : "Unable to inspect spec"], changedPaths: [] });
		}
	}
	const counts = { clean: 0, dirty: 0, error: 0 };
	for (const row of specs) counts[row.status]++;
	let status: KnowledgeReviewReport["status"] = "clean";
	if (counts.error || warnings.length) status = "error";
	else if (counts.dirty) status = "dirty";
	return { status, counts, specs, warnings };
}

/** Explicit user/agent attestation only. Auditing and indexing never call this. */
export async function acknowledgeKnowledgeReviews(rootPath: string, paths: string[]): Promise<string[]> {
	if (!paths.length) throw new Error("At least one reviewed spec is required");
	const root = await realpath(rootPath);
	const selected = [...new Set(paths.map(relativePath))];
	const eligible = new Set(await scanProjectDocuments(root));
	const collector = new ReviewCollector(root);
	// Validate every selection before writing any receipts.
	const receipts: Receipt[] = [];
	for (const spec of selected) {
		if (!eligible.has(spec)) throw new Error(`Spec is outside configured document selection: ${spec}`);
		receipts.push({ version: 1, spec, reviewedAt: new Date().toISOString(), files: await collector.collect(spec) });
	}
	for (const receipt of receipts) {
		const destination = receiptPath(root, receipt.spec);
		await mkdir(path.dirname(destination), { recursive: true });
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
			await rename(temporary, destination);
		} finally { await rm(temporary, { force: true }); }
	}
	return selected;
}
