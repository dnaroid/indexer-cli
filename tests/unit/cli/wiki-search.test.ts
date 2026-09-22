import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	discover: vi.fn(),
	search: vi.fn(),
	withRuntime: vi.fn(),
}));

vi.mock("../../../src/knowledge/service.js", () => ({
	summarizeKnowledgeCandidates: (candidates: unknown[]) => ({ candidateCount: candidates.length }),
}));
vi.mock("../../../src/cli/format/knowledge.js", () => ({
	candidateReviewRecommendation: (summary: { candidateCount: number }) =>
		summary.candidateCount > 0 ? "review candidates" : undefined,
}));
vi.mock("../../../src/cli/commands/wiki-runtime.js", () => ({
	withWikiRuntime: mocks.withRuntime,
}));
vi.mock("../../../src/cli/commands/wiki-search-runtime.js", () => ({
	parseWikiSearchMode: (mode: string | undefined) => mode ?? "hybrid",
	withWikiSearch: async (_runtime: unknown, _mode: string, action: (engine: unknown) => Promise<void>) => action({
		search: mocks.search,
		getDiagnostics: () => ({}),
	}),
}));

import { registerWikiSearchCommand } from "../../../src/cli/commands/wiki-search.js";

describe("wiki search output", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.search.mockResolvedValue([{
			path: "docs/auth.md", title: "Authentication contract", summary: "A sufficiently long summary that proves verbose mode does not compact meaningful result details.",
			score: 1, authority: "registered", status: "fresh", trust: "verified", reasonCodes: ["semantic", "body:1"], bestRanges: [],
		}]);
		mocks.discover.mockResolvedValue([{}]);
		mocks.withRuntime.mockImplementation(async (action: (runtime: unknown) => Promise<void>) => action({
			service: { discover: mocks.discover }, indexWarning: undefined,
		}));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	async function run(...args: string[]): Promise<string[]> {
		const wiki = new Command();
		registerWikiSearchCommand(wiki);
		await wiki.parseAsync(["node", "idx", "search", "auth", ...args]);
		return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
	}

	it("keeps default output compact without discovery, while verbose restores guidance and details", async () => {
		const normal = await run();
		expect(mocks.discover).not.toHaveBeenCalled();
		expect(normal.join("\n")).not.toContain("title=");

		const verbose = await run("--verbose");
		expect(mocks.discover).toHaveBeenCalledOnce();
		expect(verbose.join("\n")).toContain("title=Authentication contract");
		expect(verbose.join("\n")).toContain("why=semantic,body:1");
		expect(verbose.join("\n")).toContain("Recommendation: review candidates");
	});

	it("retains JSON discovery fields", async () => {
		const output = await run("--json");
		expect(mocks.discover).toHaveBeenCalledOnce();
		const payload = JSON.parse(output[0] ?? "{}");
		expect(payload).toMatchObject({ query: "auth", candidateCount: 1, recommendation: "review candidates" });
		expect(payload.results[0]).toMatchObject({ path: "docs/auth.md", title: "Authentication contract" });
	});
});
