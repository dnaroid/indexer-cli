import type { AskAction } from "./routes.js";

export interface AskEvidence { id: string; text: string; source?: string }
export interface AskCommandResult { stdout: string; stderr: string; failed: boolean; }

// Preserve complete maintenance reports, including unfamiliar advisory diagnostics.
const MAINTENANCE_REPORTS = new Set(["audit"]);
const NOTICE = /^(?:\s*(?:WARN(?:ING)?\b|Warning:|Warnings:|! |TRUNC\b|NEXT\b|next cursor:|Retrieval:|Bootstrap:|Review:|Verify:|Read next:|Actions:|⚠|CYCLE\b|UNRESOLVED\b|Detected indexer-cli|IDX\b|INDEX\b)|no indexed project knowledge|No (?:indexed|matching|results)|Path '.+' not found)/i;
const SEARCH_SOURCE = /^(.+:\d+-\d+) \(score:/;
const CONTEXT_SOURCE = /^(?:(?:Specifications|Documents|Implementation|Tests): \(\d+\) |\s+)?[SDCT] (\S+?)(?=\s|\s+—|$)/;
const TEST_HINT = /^T (\S+) -> \S+ .+ conf=(?:high|medium|low)$/;
const READ_ONLY_POLICY = /^IDX stale reason=ask-read-only action=Run-idx-index-explicitly-to-refresh\. ms=\d+$/;

function authoritativeSource(action: AskAction, line: string): string | undefined {
	switch (action.tool) {
		case "search": return SEARCH_SOURCE.exec(line)?.[1];
		case "context": return CONTEXT_SOURCE.exec(line)?.[1];
		case "ast": return /^AST (\S+) language=/.exec(line)?.[1];
		case "explain": {
			const match = /^File:\s+(\S+) \(lines (\d+-\d+)\)/.exec(line);
			return match ? `${match[1]}:${match[2]}` : undefined;
		}
		case "deps": return /^M (\S+) mode=/.exec(line)?.[1];
		default: return undefined;
	}
}

function supportedOutput(action: AskAction, stdout: string): boolean {
	switch (action.tool) {
		case "context": return /^(?:Documents|Specifications|Implementation|Tests):/m.test(stdout) && /\b[SDCT] \S+/.test(stdout);
		case "search": return stdout.split("\n").some(line => SEARCH_SOURCE.test(line));
		case "architecture": return /^File stats by language$/m.test(stdout);
		case "structure": return /^\s*[^:\n]*\.[\w]+(?:\s+—.*|\s*$)|^\s*[\w@./-]+\/(?:\s|$)/m.test(stdout);
		case "ast": return /^AST \S+ language=/m.test(stdout);
		case "explain": return /^File:\s+\S+ \(lines \d+-\d+\)/m.test(stdout);
		case "deps": return /^M \S+ mode=/m.test(stdout);
		case "audit": return /^Changed paths:/m.test(stdout);
	}
}

/** Copy command output, never ask the model to rewrite it or identify warnings. */
export function collectEvidence(action: AskAction, result: AskCommandResult, operation: number): { notices: string[]; modelNotices: string[]; evidence: AskEvidence[] } {
	const label = `idx ${action.tool}${action.target ? ` ${action.target}` : action.tool === "structure" && action.pathPrefix ? ` ${action.pathPrefix}` : ""}`;
	const notices: string[] = [];
	const evidence: AskEvidence[] = [];
	const modelNotices: string[] = [];
	const stderr = result.stderr.replace(/^ASK snapshot: indexed retrieval uses the existing snapshot without automatic indexing; it may be stale\. Run idx index explicitly to refresh\.\s*\n?/gm, "").replace(/^IDX stale reason=ask-read-only action=Run-idx-index-explicitly-to-refresh\. ms=\d+\s*\n?/gm, "").trim();
	if (stderr) notices.push(`[${label} stderr]\n${stderr}`);
	if (result.failed) notices.push(`[${label}] retrieval failed or incomplete; evidence may be partial.`);
	if (MAINTENANCE_REPORTS.has(action.tool)) {
		if (result.stdout.trim()) notices.push(`[${label}]\n${result.stdout.trimEnd()}`);
		if (supportedOutput(action, result.stdout)) evidence.push({ id: `${operation}.1`, text: `[${label}]\n${result.stdout.trimEnd()}`, source: label });
		return { notices, modelNotices: [...notices], evidence };
	}
	if (action.tool === "architecture") {
		const cycles = [...result.stdout.matchAll(/^CYCLE\b/gm)].length;
		const unresolved = [...result.stdout.matchAll(/^UNRESOLVED\b/gm)].length;
		if (cycles || unresolved) notices.push(`[${label}] architecture diagnostics: ${cycles} dependency cycles, ${unresolved} unresolved dependencies.`);
		// The model needs complete edges and actions to reason about architecture;
		// only the final user-facing notice is summarized.
		const diagnostics = result.stdout.match(/(?:^|\n)(?:⚠ Cyclic dependencies detected:|CYCLE\b|UNRESOLVED\b|Actions:)[\s\S]*/);
		if (diagnostics) modelNotices.push(`[${label} diagnostics]\n${diagnostics[0].trim()}`);
	}
	if (!supportedOutput(action, result.stdout)) {
		if (result.stdout.trim() && !READ_ONLY_POLICY.test(result.stdout.trim())) notices.push(`[${label}: no recognized source evidence]`);
		return { notices, modelNotices: [...notices, ...modelNotices], evidence };
	}
	let buffer = "";
	let section = "";
	let sources: string[] = [];
	let activeSource: string | undefined;
	const tree = new Map<number, string>();
	let inNotice = false;
	let inActions = false;
	let inReadNext = false;
	let inCycle = false;
	let inArchitectureCycle = false;
	let searchBodyLines = 0;
	let searchAwaitContent = false;
	let searchUnframed = false;
	let explainBody = false;
	let previousBlank = false;
	const structurePrefix = action.tool === "structure" && action.pathPrefix && !/^Path '.+' not found/m.test(result.stdout)
		? `${action.pathPrefix.replace(/\/+$/, "")}/` : "";
	const lines = result.stdout.trimEnd().split("\n");
	const sourcePattern = action.tool === "search" ? SEARCH_SOURCE : undefined;
	const firstResult = sourcePattern ? lines.findIndex(line => sourcePattern.test(line)) : -1;
	const footerPattern = action.tool === "search" ? /^Read next:/ : /^Recommendation:/;
	const resultEnd = sourcePattern && !result.failed && footerPattern.test(lines[lines.length - 1] ?? "") ? lines.length - 1 : lines.length;
	const flush = (continuation = false): void => {
		if (!buffer.trim()) { buffer = ""; return; }
		evidence.push({ id: `${operation}.${evidence.length + 1}`, text: `[${label}${section ? ` / ${section}` : ""}]\n${buffer.trimEnd()}`, source: sources.length ? [...new Set(sources)].join(", ") : label });
		buffer = "";
		// A length split continues the same formatter row/body. A real heading,
		// notice or source boundary must not carry provenance into the next row.
		sources = continuation && activeSource ? [activeSource] : [];
		if (!continuation) activeSource = undefined;
	};
	for (const [index, line] of lines.entries()) {
		if (action.tool === "context" && /^CONTEXT query=/.test(line)) continue;
		// Search prints a counted content region after each result header. Never
		// interpret content as a new result, even when it looks exactly like one.
		const searchBody = action.tool === "search" && searchBodyLines > 0;
		if (searchBody) searchBodyLines--;
		const searchHeader = action.tool === "search" && !searchBody && !searchAwaitContent && !searchUnframed
			? SEARCH_SOURCE.exec(line) : null;
		if (searchHeader) searchAwaitContent = true;
		else if (action.tool === "search" && searchAwaitContent) {
			const marker = /^Content: (\d+) lines$/.exec(line);
			if (marker) {
				searchBodyLines = Number(marker[1]);
				searchAwaitContent = false;
			} else if (!/^  kind=/.test(line)) {
				// Legacy unframed results are still evidence, but further apparent
				// headers cannot be trusted as metadata.
				searchAwaitContent = false;
				searchUnframed = true;
			}
		}
		if (action.tool === "explain") {
			if (explainBody && previousBlank && /^Symbol: /.test(line)) explainBody = false;
			if (line === "Body preview:") explainBody = true;
			previousBlank = line === "";
		}
		if (action.tool === "architecture" && (/^⚠ Cyclic dependencies detected:|^CYCLE\b|^UNRESOLVED\b|^Actions:$/.test(line) || inActions || (inArchitectureCycle && /^\s+/.test(line)))) {
			if (/^CYCLE\b/.test(line)) inArchitectureCycle = true;
			if (/^Actions:$/.test(line)) { inActions = true; inArchitectureCycle = false; }
			if (/^UNRESOLVED\b/.test(line)) inArchitectureCycle = false;
			continue;
		}
		// Search prints warnings before results and its generated guidance after them.
		// Inside the result region even "Recommendation:" is untrusted source text.
		const retrievedContent = firstResult >= 0 && index >= firstResult && index < resultEnd;
		if (!retrievedContent && !explainBody && READ_ONLY_POLICY.test(line)) continue;
		if (action.tool === "architecture" && line === "Actions:") inActions = true;
		const continuation = inNotice && /^\s+(?:[-*]|\d+[.)])\s+/.test(line);
		const readNextContinuation = inReadNext && /^\s+>\s+/.test(line);
		const cycleContinuation = inCycle && /^\s+(?:\S|$)/.test(line);
		const structureFile = action.tool === "structure" && !/^Path '.+' not found/.test(line)
			&& /^\s*[^/]+\.[^/]+(?:\s+—.*)?$/.test(line.trim());
		if (!retrievedContent && !explainBody && (inActions || (!structureFile && NOTICE.test(line)) || continuation || readNextContinuation || cycleContinuation)) {
			flush(); notices.push(line); inNotice = true;
			if (/^Read next:/.test(line)) inReadNext = true;
			else if (inReadNext && !readNextContinuation) inReadNext = false;
			if (/^CYCLE\b/.test(line)) inCycle = true;
			else if (inCycle && !cycleContinuation) inCycle = false;
			continue;
		}
		if (inReadNext && !readNextContinuation) inReadNext = false;
		if (inCycle && !cycleContinuation) inCycle = false;
		if (line.trim()) inNotice = false;
		// Context sections carry provenance. Repeat the heading across chunks.
		if (action.tool === "explain" && /^Symbol: /.test(line) && buffer.trim()) flush();
		const heading = !retrievedContent && /^(Documents|Specifications|Implementation|Tests|Document relations|Read next):/.exec(line);
		if (heading) { flush(); section = heading[1]; }
		const source = searchHeader;
		if (source) { flush(); section = source[1]; }
		// Each formatter source row owns its own citation. A Tests heading is a
		// category, not provenance; body previews cannot mint additional sources.
		let rowSource: string | undefined;
		if (action.tool === "context") rowSource = CONTEXT_SOURCE.exec(line)?.[1];
		else if ((action.tool === "explain" && !explainBody) || action.tool === "deps") rowSource = TEST_HINT.exec(line)?.[1];
		if (rowSource && buffer.trim()) flush();
		if (action.tool === "structure") {
			const indent = line.match(/^\s*/)?.[0].length ?? 0;
			const entry = line.trim();
			if (/^[\w@.-]+(?:\/[\w@.-]+)*\/$/.test(entry)) {
				for (const level of tree.keys()) if (level >= indent) tree.delete(level);
				tree.set(indent, entry);
				flush(); section = [...tree.entries()].sort((a,b) => a[0]-b[0]).map(([,value]) => value).join("");
				section = structurePrefix + section;
			} else if (/^[^/]+\.[^/]+(?:\s+—.*)?$/.test(entry)) {
				flush();
				for (const level of tree.keys()) if (level >= indent) tree.delete(level);
				section = `${structurePrefix}${[...tree.entries()].sort((a,b) => a[0]-b[0]).map(([,value]) => value).join("")}${entry.split(/\s+—/)[0]}`;
			}
		}
		const pointer = action.tool === "search" ? searchHeader?.[1]
			: action.tool === "explain" && explainBody ? undefined
			: action.tool === "structure" ? TEST_HINT.exec(line)?.[1]
			: rowSource || authoritativeSource(action, line);
		if (pointer && activeSource && pointer !== activeSource && buffer.trim()) flush();
		if (buffer.length + line.length > 1800) flush(true);
		if (pointer) { sources.push(pointer); activeSource = pointer; }
		if (action.tool === "structure" && section && (structureFile || /^[\w@.-]+(?:\/[\w@.-]+)*\/$/.test(line.trim()))) {
			sources.push(section);
			activeSource = section;
		}
		// A single long source line stays intact (pager explicitly reports overflow).
		buffer += `${line}\n`;
	}
	flush();
	return { notices, modelNotices: [...notices, ...modelNotices], evidence };
}
