import { describe, expect, it } from "vitest";
import { isJsonOutput } from "../../../src/cli/output-mode.js";

describe("CLI output mode", () => {
	it("defaults to JSON output when no flag is passed", () => {
		expect(isJsonOutput()).toBe(true);
		expect(isJsonOutput({})).toBe(true);
	});

	it("switches to human-readable output when --txt is requested", () => {
		expect(isJsonOutput({ txt: true })).toBe(false);
		expect(isJsonOutput({ txt: false })).toBe(true);
	});
});
