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

const PYTHON_BUILTINS = new Set([
	"abc",
	"argparse",
	"ast",
	"asyncio",
	"base64",
	"bisect",
	"calendar",
	"cmath",
	"collections",
	"concurrent",
	"configparser",
	"contextlib",
	"contextvars",
	"copy",
	"csv",
	"ctypes",
	"dataclasses",
	"datetime",
	"decimal",
	"difflib",
	"enum",
	"fileinput",
	"functools",
	"glob",
	"gzip",
	"hashlib",
	"hmac",
	"http",
	"io",
	"itertools",
	"json",
	"keyword",
	"linecache",
	"locale",
	"logging",
	"mailbox",
	"marshal",
	"math",
	"mimetypes",
	"multiprocessing",
	"numbers",
	"operator",
	"os",
	"pathlib",
	"pickle",
	"platform",
	"pprint",
	"queue",
	"re",
	"secrets",
	"select",
	"shelve",
	"signal",
	"smtplib",
	"socket",
	"sqlite3",
	"ssl",
	"statistics",
	"string",
	"struct",
	"subprocess",
	"sys",
	"tarfile",
	"tempfile",
	"textwrap",
	"threading",
	"time",
	"traceback",
	"typing",
	"unicodedata",
	"unittest",
	"urllib",
	"uuid",
	"warnings",
	"weakref",
	"xml",
	"zipfile",
	"zlib",
]);

const RUBY_BUILTINS = new Set([
	"base64",
	"benchmark",
	"bigdecimal",
	"csv",
	"date",
	"delegate",
	"digest",
	"drb",
	"erb",
	"etc",
	"fcntl",
	"fiddle",
	"fileutils",
	"find",
	"forwardable",
	"getoptlong",
	"io",
	"ipaddr",
	"json",
	"logger",
	"matrix",
	"minitest",
	"monitor",
	"net",
	"nkf",
	"objspace",
	"observer",
	"open3",
	"optparse",
	"ostruct",
	"pathname",
	"pp",
	"prettyprint",
	"prime",
	"pstore",
	"psych",
	"pty",
	"racc",
	"random",
	"rdoc",
	"readline",
	"resolv",
	"rexml",
	"ripper",
	"rss",
	"rubygems",
	"scanf",
	"sdbm",
	"securerandom",
	"set",
	"shell",
	"shellwords",
	"singleton",
	"socket",
	"stringio",
	"stringio",
	"strscan",
	"syslog",
	"tempfile",
	"test",
	"thread",
	"thwait",
	"time",
	"timeout",
	"tmpdir",
	"tracer",
	"tsort",
	"un",
	"uri",
	"weakref",
	"webrick",
	"yaml",
	"zlib",
]);

const CSHARP_SYSTEM_NAMESPACES = new Set([
	"System",
	"Microsoft",
	"Mono",
	"NET",
]);

const IMPORT_SPECIFIER_EXTENSION = /\.(?:jsx?|mjs|cjs)$/i;
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const TS_INDEX_CANDIDATES = ["/index.ts", "/index.tsx"];

type ResolveResult = {
	toPath?: string;
	dependencyType: "internal" | "external" | "builtin";
};

export function resolveDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
	languageId?: string,
): ResolveResult {
	switch (languageId) {
		case "python":
			return resolvePythonDependency(importSpecifier, fromFilePath, knownFiles);
		case "csharp":
			return resolveCSharpDependency(importSpecifier, fromFilePath, knownFiles);
		case "gdscript":
			return resolveGDScriptDependency(
				importSpecifier,
				fromFilePath,
				knownFiles,
			);
		case "ruby":
			return resolveRubyDependency(importSpecifier, fromFilePath, knownFiles);
		default:
			return resolveTSDependency(importSpecifier, fromFilePath, knownFiles);
	}
}

function resolveTSDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
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

	for (const extension of TS_EXTENSIONS) {
		candidates.add(`${extensionlessPath}${extension}`);
	}

	for (const indexPath of TS_INDEX_CANDIDATES) {
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

function resolvePythonDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
	const topLevel = importSpecifier.split(".")[0];
	if (PYTHON_BUILTINS.has(topLevel)) {
		return { dependencyType: "builtin" };
	}

	if (importSpecifier.startsWith(".")) {
		return resolvePythonRelativeImport(
			importSpecifier,
			fromFilePath,
			knownFiles,
		);
	}

	const parts = importSpecifier.split(".");
	for (let i = parts.length; i >= 1; i--) {
		const prefix = parts.slice(0, i).join("/");

		for (const suffix of ["", ".py", "/__init__.py"]) {
			const candidate = normalizePath(prefix + suffix);
			if (knownFiles.has(candidate)) {
				return { dependencyType: "internal", toPath: candidate };
			}
		}
	}

	return { dependencyType: "external" };
}

function resolvePythonRelativeImport(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
	const normalizedFrom = normalizePath(fromFilePath);
	const fromDir = dirname(normalizedFrom);

	const dotMatch = importSpecifier.match(/^(\.+)(.*)$/);
	if (!dotMatch) {
		return { dependencyType: "external" };
	}

	const dotCount = dotMatch[1].length;
	const rest = dotMatch[2];

	let baseDir = fromDir;
	for (let i = 1; i < dotCount; i++) {
		baseDir = dirname(baseDir);
	}

	const modulePath = rest ? rest.replace(/^\./, "") : "";

	if (!modulePath) {
		return { dependencyType: "internal" };
	}

	const parts = modulePath.split(".").filter(Boolean);
	const dirPath = parts.join("/");

	const candidates = [
		normalizePath(join(baseDir, dirPath + ".py")),
		normalizePath(join(baseDir, dirPath, "__init__.py")),
	];

	for (const candidate of candidates) {
		if (knownFiles.has(candidate)) {
			return { dependencyType: "internal", toPath: candidate };
		}
	}

	return { dependencyType: "internal" };
}

function resolveCSharpDependency(
	importSpecifier: string,
	_fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
	const parts = importSpecifier.split(".");
	const topLevel = parts[0];

	if (CSHARP_SYSTEM_NAMESPACES.has(topLevel)) {
		return { dependencyType: "external" };
	}

	if (importSpecifier.startsWith("Unity")) {
		return { dependencyType: "external" };
	}

	const lastNamespacePart = parts[parts.length - 1];

	for (const knownFile of knownFiles) {
		if (!knownFile.endsWith(".cs")) continue;

		const dirSegments = dirname(knownFile).split("/");
		const fileBase = knownFile.split("/").pop()?.replace(/\.cs$/i, "") || "";

		const dirMatchesLast = dirSegments.includes(lastNamespacePart);
		const fileMatchesLast = fileBase === lastNamespacePart;

		if (dirMatchesLast || fileMatchesLast) {
			return { dependencyType: "internal", toPath: knownFile };
		}
	}

	for (const part of parts) {
		for (const knownFile of knownFiles) {
			if (!knownFile.endsWith(".cs")) continue;
			const dirSegments = dirname(knownFile).split("/");

			if (dirSegments.includes(part)) {
				return { dependencyType: "internal", toPath: knownFile };
			}
		}
	}

	return { dependencyType: "external" };
}

function resolveGDScriptDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
	if (importSpecifier.startsWith("res://")) {
		const projectPath = importSpecifier.slice("res://".length);
		const candidates = [
			normalizePath(projectPath),
			normalizePath(projectPath + ".gd"),
		];

		for (const candidate of candidates) {
			if (knownFiles.has(candidate)) {
				return { dependencyType: "internal", toPath: candidate };
			}
		}
	}

	if (importSpecifier.startsWith(".") || importSpecifier.includes("/")) {
		const normalizedFrom = normalizePath(fromFilePath);
		const fromDir = dirname(normalizedFrom);
		const basePath = normalizePath(join(fromDir, importSpecifier));

		const candidates = [
			basePath,
			basePath + ".gd",
			basePath + ".tscn",
			normalizePath(join(basePath, "index.gd")),
		];

		for (const candidate of candidates) {
			if (knownFiles.has(candidate)) {
				return { dependencyType: "internal", toPath: candidate };
			}
		}
	}

	for (const knownFile of knownFiles) {
		if (!knownFile.endsWith(".gd")) continue;
		const className = knownFile.split("/").pop()?.replace(".gd", "");
		if (className && className === importSpecifier) {
			return { dependencyType: "internal", toPath: knownFile };
		}
	}

	return { dependencyType: "external" };
}

function resolveRubyDependency(
	importSpecifier: string,
	fromFilePath: string,
	knownFiles: Set<string>,
): ResolveResult {
	const topLevel = importSpecifier.split("/")[0].split(":")[0];
	if (RUBY_BUILTINS.has(topLevel)) {
		return { dependencyType: "builtin" };
	}

	if (!importSpecifier.startsWith(".")) {
		return { dependencyType: "external" };
	}

	const normalizedFrom = normalizePath(fromFilePath);
	const fromDir = dirname(normalizedFrom);
	const basePath = normalizePath(join(fromDir, importSpecifier));

	const candidates = [
		basePath,
		basePath + ".rb",
		normalizePath(join(basePath, "index.rb")),
	];

	for (const candidate of candidates) {
		if (knownFiles.has(candidate)) {
			return { dependencyType: "internal", toPath: candidate };
		}
	}

	return { dependencyType: "internal" };
}

function normalizePath(filePath: string): string {
	return normalize(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}
