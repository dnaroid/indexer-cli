try {
	require("better-sqlite3");
} catch {
	console.error(
		[
			"",
			"\u26A0 indexer-cli: native modules could not be loaded.",
			"  This usually means build tools (python3, make, C++ compiler) are missing.",
			"",
			"  Install build tools, then run:",
			"    npm install -g indexer-cli",
			"",
		].join("\n"),
	);
}
