import { createHash } from "node:crypto";
import ts from "typescript";
import type { KnowledgeVerificationSelector } from "../../core/types.js";
const fingerprint = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Resolves complete semantic regions. Unsupported syntax intentionally falls back to a whole-file fingerprint. */
export function resolveVerificationSelector(content: string, kind: KnowledgeVerificationSelector["kind"], value: string): KnowledgeVerificationSelector {
	let selected: string;
	if (kind === "json-pointer") {
		let node: unknown; try { node = JSON.parse(content); } catch { throw new Error("Selector JSON is invalid"); }
		if (value !== "" && !value.startsWith("/")) throw new Error("JSON pointer must start with '/'.");
		for (const raw of value.split("/").slice(1)) {
			const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
			if (!node || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, token)) throw new Error(`Selector is missing: ${value}`);
			node = (node as Record<string, unknown>)[token];
		}
		selected = JSON.stringify(node);
	} else if (kind === "document-section") {
		const lines = content.split(/(?<=\n)/); const target = new RegExp(`^(#{1,6})\\s+${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*#*\\s*$`, "i");
		const hits = lines.map((line, i) => ({ line, i, m: line.match(target) })).filter((x) => x.m);
		if (hits.length !== 1) throw new Error(`Selector is ${hits.length ? "ambiguous" : "missing"}: ${value}`);
		const level = hits[0].m![1].length; let end = lines.length;
		for (let i = hits[0].i + 1; i < lines.length; i++) { const m = lines[i].match(/^(#{1,6})\s+/); if (m && m[1].length <= level) { end = i; break; } }
		selected = lines.slice(hits[0].i, end).join("");
	} else {
		const source = ts.createSourceFile("selector.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const matches: ts.Node[] = [];
		const visit = (node: ts.Node) => {
			const named = (node as ts.NamedDeclaration).name;
			if (named && ts.isIdentifier(named) && named.text === value && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node))) matches.push(node);
			ts.forEachChild(node, visit);
		}; visit(source);
		if (matches.length !== 1) throw new Error(`Selector is ${matches.length ? "ambiguous" : "missing"}: ${value}`);
		selected = matches[0].getFullText(source);
	}
	return { kind, value, fingerprint: fingerprint(selected) };
}
