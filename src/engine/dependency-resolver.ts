import { dirname, join, normalize } from "node:path";

const NODE_BUILTINS = new Set([
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"crypto",
	"dns",
	"events",
	"fs",
	"http",
	"https",
	"net",
	"os",
	"path",
	"punycode",
	"querystring",
	"readline",
	"stream",
	"string_decoder",
	"tls",
	"url",
	"util",
	"zlib",
]);

const IMPORT_SPECIFIER_EXTENSION = /\.(?:jsx?|mjs|cjs)$/i;
const INTERNAL_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const INTERNAL_INDEX_CANDIDATES = ["/index.ts", "/index.tsx"];

export function resolveDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): { toPath?: string; dependencyType: "internal" | "external" | "builtin" } {
	if (importSpecifier.startsWith("node:")) {
		return { dependencyType: "builtin" };
	}

	const builtinCandidate = importSpecifier.split("/")[0];
	if (NODE_BUILTINS.has(builtinCandidate)) {
		return { dependencyType: "builtin" };
	}

	if (!importSpecifier.startsWith(".")) {
		return { dependencyType: "external" };
	}

	const normalizedFrom = normalizePath(fromFilePath);
	const basePath = normalizePath(
		join(dirname(normalizedFrom), importSpecifier),
	);
	const extensionlessPath = basePath.replace(IMPORT_SPECIFIER_EXTENSION, "");
	const candidates = new Set<string>();

	candidates.add(basePath);
	candidates.add(extensionlessPath);

	for (const extension of INTERNAL_FILE_EXTENSIONS) {
		candidates.add(`${extensionlessPath}${extension}`);
	}

	for (const indexPath of INTERNAL_INDEX_CANDIDATES) {
		candidates.add(`${extensionlessPath}${indexPath}`);
	}

	for (const candidate of candidates) {
		const normalizedCandidate = normalizePath(candidate);
		if (knownFiles.has(normalizedCandidate)) {
			return {
				dependencyType: "internal",
				toPath: normalizedCandidate,
			};
		}
	}

	return { dependencyType: "internal" };
}

function normalizePath(filePath: string): string {
	return normalize(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}
