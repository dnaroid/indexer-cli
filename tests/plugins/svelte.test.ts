import { describe, expect, it } from "vitest";
import { SveltePlugin } from "../../src/languages/svelte.ts";

const plugin = new SveltePlugin();

const SOURCE = `<script module lang="ts">
	export const load = async () => import("./server");
</script>
<script lang="ts">
	import Button from "./Button.svelte";
	interface User { name: string }
	export let title: string;
	let { count = 0, label }: { count?: number; label: string } = $props();
	const handleClick = () => helper();
	function helper() { return new Date(); }
	class Store { update() { helper(); } }
</script>
{#snippet row(item)}<button>{item}</button>{/snippet}
<Button>{title} {count} {label}</Button>
<style>.button { color: red }</style>`;

function parseSource(content = SOURCE) {
	return plugin.parse({ path: "src/routes/+page.svelte", content });
}

describe("SveltePlugin", () => {
	it("parses a component and exposes a traversable AST", () => {
		const parsed = parseSource();
		const ast = parsed.ast as {
			tree: { rootNode: { type: string; namedChildren: unknown[] } };
		};

		expect(parsed.languageId).toBe("svelte");
		expect(ast.tree.rootNode.type).toBe("Root");
		expect(ast.tree.rootNode.namedChildren.length).toBeGreaterThan(0);
	});

	it("exposes callable names and callees for dependency call traversal", () => {
		type Node = {
			type: string;
			startIndex: number;
			endIndex: number;
			namedChildren: Node[];
			childForFieldName(name: string): Node | null;
		};
		const ast = parseSource().ast as {
			source: string;
			tree: { rootNode: Node };
		};
		const nodes: Node[] = [];
		const visit = (node: Node) => {
			nodes.push(node);
			for (const child of node.namedChildren) visit(child);
		};
		visit(ast.tree.rootNode);
		const text = (node: Node | null) =>
			node ? ast.source.slice(node.startIndex, node.endIndex) : undefined;

		const handler = nodes.find(
			(node) =>
				node.type === "VariableDeclarator" &&
				text(node.childForFieldName("name")) === "handleClick",
		);
		expect(handler).toBeDefined();
		const helperCall = handler?.namedChildren
			.flatMap(function descendants(node: Node): Node[] {
				return [node, ...node.namedChildren.flatMap(descendants)];
			})
			.find((node) => node.type === "CallExpression");
		expect(text(helperCall?.childForFieldName("function") ?? null)).toBe(
			"helper",
		);
	});

	it("extracts component, script, prop, method, and snippet symbols", () => {
		const symbols = plugin.extractSymbols(parseSource());
		const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

		expect(byName.get("+page")?.kind).toBe("component");
		expect(byName.get("load")).toMatchObject({ kind: "function", exported: true });
		expect(byName.get("User")?.kind).toBe("interface");
		expect(byName.get("title")?.kind).toBe("prop");
		expect(byName.get("count")?.kind).toBe("prop");
		expect(byName.get("label")?.kind).toBe("prop");
		expect(byName.get("handleClick")?.kind).toBe("function");
		expect(byName.get("helper")?.kind).toBe("function");
		expect(byName.get("Store")?.kind).toBe("class");
		expect(byName.get("update")).toMatchObject({
			kind: "method",
			containerName: "Store",
		});
		expect(byName.get("row")?.metadata).toMatchObject({
			frameworkConstruct: "snippet",
		});
	});

	it("extracts imports and re-exports from both script contexts", () => {
		const parsed = parseSource(
			SOURCE.replace(
				"export const load",
				'export { load } from "./load";\n\texport const routeLoad',
			),
		);
		const imports = plugin.extractImports(parsed);

		expect(imports.map(({ kind, spec }) => ({ kind, spec }))).toEqual(
			expect.arrayContaining([
				{ kind: "export", spec: "./load" },
				{ kind: "dynamic_import", spec: "./server" },
				{ kind: "import", spec: "./Button.svelte" },
			]),
		);
	});

	it("extracts dynamic imports from template expressions", () => {
		const imports = plugin.extractImports(
			parseSource("{#await import('./lazy')}<p>Loading</p>{/await}"),
		);

		expect(imports).toEqual([
			expect.objectContaining({ kind: "dynamic_import", spec: "./lazy" }),
		]);
	});

	it("creates non-empty chunks bounded by maxTokens", () => {
		const parsed = parseSource(
			`${SOURCE}\n<p>${"x".repeat(500)}</p>`,
		);
		const chunks = plugin.splitIntoChunks(parsed, {
			targetTokens: 30,
			maxTokens: 40,
		});

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.languageId).toBe("svelte");
			expect(chunk.content.length).toBeGreaterThan(0);
			expect(chunk.estimatedTokens).toBeLessThanOrEqual(40);
			expect(chunk.range.endLine).toBeGreaterThanOrEqual(chunk.range.startLine);
		}
	});

	it("ranks App.svelte and SvelteKit route entrypoints", () => {
		expect(
			plugin.getEntrypoints([
				"src/lib/Card.svelte",
				"src/routes/+page.svelte",
				"src/App.svelte",
			]),
		).toEqual(["src/App.svelte", "src/routes/+page.svelte"]);
	});

	it("rejects malformed Svelte so the indexer can apply its fallback", () => {
		expect(() => parseSource("{#if open}<div>{/each}")).toThrow();
	});
});
