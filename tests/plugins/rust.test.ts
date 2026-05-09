import { describe, expect, it } from "vitest";
import { RustPlugin } from "../../src/languages/rust";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new RustPlugin();
const SOURCE = readFixtureAsSource("rust-basic/src/lib.rs");

describe("RustPlugin", () => {
	const parsed = plugin.parse(SOURCE);
	const symbols = plugin.extractSymbols(parsed);
	const imports = plugin.extractImports(parsed);
	const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

	it("parse returns correct structure", () => {
		expect(parsed.languageId).toBe("rust");
		expect(parsed.path).toBe(SOURCE.path);
		expect(parsed.ast).toBeTruthy();
		expect(parsed.meta?.frameworkHint).toBe("cargo");
	});

	it("extracts Rust symbols with visibility, containers, and docs", () => {
		expect(symbols.find((symbol) => symbol.name === "Order")).toMatchObject({
			kind: "struct",
			exported: true,
			docComment: "User order aggregate.",
		});
		expect(symbols.find((symbol) => symbol.name === "Status")).toMatchObject({
			kind: "enum",
			exported: true,
		});
		expect(symbols.find((symbol) => symbol.name === "Pending")).toMatchObject({
			kind: "enum_variant",
			containerName: "Status",
			exported: true,
		});
		expect(
			symbols.find((symbol) => symbol.name === "Repository"),
		).toMatchObject({
			kind: "trait",
			exported: true,
		});
		expect(symbols.find((symbol) => symbol.name === "save")).toMatchObject({
			kind: "function",
			containerName: "Repository",
		});
		expect(symbols.find((symbol) => symbol.name === "new")).toMatchObject({
			kind: "function",
			containerName: "Order",
			exported: true,
		});
		expect(symbols.find((symbol) => symbol.name === "run")).toMatchObject({
			kind: "function",
			exported: true,
		});
	});

	it("extracts use, mod, and extern crate dependencies", () => {
		expect(imports.map((dependency) => dependency.spec)).toEqual(
			expect.arrayContaining([
				"crate::errors::AppError",
				"crate::services::auth::AuthService",
				"std::collections::HashMap",
				"errors",
				"services",
			]),
		);
		expect(
			imports.find((dependency) => dependency.spec === "errors"),
		).toMatchObject({
			kind: "include",
			metadata: { syntax: "mod" },
		});
	});

	it("splits imports, type declarations, impl blocks, and functions into chunks", () => {
		expect(chunks.length).toBeGreaterThan(0);
		expect(
			chunks.find((chunk) => chunk.metadata?.chunkType === "imports"),
		).toBeDefined();
		expect(
			chunks.find((chunk) => chunk.metadata?.primarySymbol === "Order"),
		).toMatchObject({ languageId: "rust", metadata: { chunkType: "types" } });
		expect(
			chunks.find((chunk) => chunk.metadata?.primarySymbol === "impl Order"),
		).toMatchObject({ languageId: "rust", metadata: { chunkType: "impl" } });
		expect(
			chunks.find((chunk) => chunk.metadata?.primarySymbol === "run"),
		).toMatchObject({ languageId: "rust", metadata: { chunkType: "impl" } });
	});

	it("returns Cargo-style entrypoints", () => {
		expect(
			plugin.getEntrypoints?.([
				"src/lib.rs",
				"src/main.rs",
				"src/bin/import.rs",
				"examples/demo.rs",
				"src/services/auth.rs",
			]),
		).toEqual([
			"src/lib.rs",
			"src/main.rs",
			"src/bin/import.rs",
			"examples/demo.rs",
		]);
	});
});
