import fs from "node:fs";
import path from "node:path";

let version = "0.0.0";

try {
	const pkgPath = path.join(__dirname, "..", "..", "package.json");
	const raw = fs.readFileSync(pkgPath, "utf-8");
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"version" in parsed &&
		typeof (parsed as { version: unknown }).version === "string"
	) {
		version = (parsed as { version: string }).version;
	}
} catch {}

export const PACKAGE_VERSION: string = version;
