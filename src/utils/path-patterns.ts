function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function pathPatternToRegExp(pattern: string): RegExp {
	const normalized = normalizePath(pattern.trim());
	const doubleWildcardToken = "__INDEXER_DOUBLE_WILDCARD__";
	let regexSource = escapeRegExp(normalized)
		.replace(/\*\*/g, doubleWildcardToken)
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(new RegExp(doubleWildcardToken, "g"), ".*");

	if (normalized.endsWith("/**")) {
		regexSource = `${regexSource.replace(/\/\.\*$/, "")}(?:/.*)?`;
	}

	return new RegExp(`^${regexSource}$`);
}

export function sanitizePathPatterns(patterns: readonly string[]): string[] {
	return patterns
		.map((value) => normalizePath(value.trim()))
		.filter((value) => value.length > 0);
}

export function matchesPathPatterns(
	filePath: string,
	patterns: readonly string[],
): boolean {
	const normalizedPath = normalizePath(filePath);

	for (const pattern of sanitizePathPatterns(patterns)) {
		if (!pattern.includes("*") && !pattern.includes("?")) {
			if (normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`)) {
				return true;
			}
			continue;
		}

		if (pathPatternToRegExp(pattern).test(normalizedPath)) {
			return true;
		}
	}

	return false;
}

export function mayContainPathPatternMatch(
	directoryPath: string,
	patterns: readonly string[],
): boolean {
	const normalizedDirectory = normalizePath(directoryPath);

	for (const pattern of sanitizePathPatterns(patterns)) {
		if (matchesPathPatterns(normalizedDirectory, [pattern])) {
			return true;
		}

		const wildcardIndex = pattern.search(/[?*]/);
		const fixedPrefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
		const prefixDirectory = fixedPrefix.includes("/")
			? fixedPrefix.slice(0, fixedPrefix.lastIndexOf("/"))
			: fixedPrefix.replace(/\/$/, "");

		if (!prefixDirectory) {
			return true;
		}

		if (
			prefixDirectory === normalizedDirectory ||
			prefixDirectory.startsWith(`${normalizedDirectory}/`) ||
			normalizedDirectory.startsWith(`${prefixDirectory}/`)
		) {
			return true;
		}
	}

	return false;
}
