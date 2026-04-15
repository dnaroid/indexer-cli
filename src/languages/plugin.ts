import { extname } from "node:path";

export interface CodeRange {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
}

export interface SourceFile {
	path: string;
	content: string;
	languageHint?: string;
	projectRoot?: string;
}

export interface ParsedFile {
	languageId: string;
	path: string;
	ast: unknown;
	meta?: Record<string, unknown>;
}

export interface LanguageSymbol {
	id: string;
	kind: string;
	name: string;
	filePath: string;
	range: CodeRange;
	exported: boolean;
	containerName?: string;
	signature?: string;
	docComment?: string;
	metadata?: Record<string, unknown>;
}

export type LanguageImportKind =
	| "import"
	| "require"
	| "dynamic_import"
	| "using"
	| "include"
	| "export"
	| "asset_reference";

export interface LanguageImport {
	id: string;
	kind: LanguageImportKind;
	spec: string;
	resolvedPath?: string;
	filePath: string;
	range: CodeRange;
	metadata?: Record<string, unknown>;
}

export interface LanguageCodeChunk {
	id: string;
	filePath: string;
	range: CodeRange;
	content: string;
	tags?: string[];
	languageId: string;
	estimatedTokens?: number;
	metadata?: Record<string, unknown>;
}

export interface ChunkOptions {
	targetTokens: number;
	maxTokens?: number;
}

export interface LanguagePlugin {
	id: string;
	displayName?: string;
	fileExtensions: string[];
	frameworks?: string[];
	getEntrypoints?(filePaths: string[], projectRoot?: string): string[];
	parse(file: SourceFile): ParsedFile;
	extractSymbols(parsed: ParsedFile): LanguageSymbol[];
	extractImports(parsed: ParsedFile): LanguageImport[];
	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[];
}

export class LanguagePluginRegistry {
	private readonly pluginsById = new Map<string, LanguagePlugin>();

	register(plugin: LanguagePlugin): void {
		if (this.pluginsById.has(plugin.id)) {
			throw new Error(
				`Language plugin with id '${plugin.id}' is already registered`,
			);
		}
		this.pluginsById.set(plugin.id, plugin);
	}

	registerMany(plugins: LanguagePlugin[]): void {
		for (const plugin of plugins) {
			this.register(plugin);
		}
	}

	list(): LanguagePlugin[] {
		return Array.from(this.pluginsById.values());
	}

	getById(id: string): LanguagePlugin | null {
		return this.pluginsById.get(id) ?? null;
	}

	findByFilePath(filePath: string): LanguagePlugin | null {
		const extension = extname(filePath).toLowerCase();
		for (const plugin of this.pluginsById.values()) {
			if (plugin.fileExtensions.includes(extension)) {
				return plugin;
			}
		}
		return null;
	}
}
