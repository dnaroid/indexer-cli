import { afterEach, expect, it, vi } from "vitest";
import { ensureIndexed } from "../../../src/cli/commands/ensure-indexed.js";

afterEach(() => vi.unstubAllEnvs());

it("ask children never trigger automatic indexing or its planning preflight", async () => {
	vi.stubEnv("IDX_ASK_CHILD", "1");
	const metadata = { getLatestCompletedSnapshot: vi.fn() };
	const result = await ensureIndexed(metadata as unknown as Parameters<typeof ensureIndexed>[0], "/unused");
	expect(result).toMatchObject({ status: "stale", reason: "ask-read-only" });
	expect(metadata.getLatestCompletedSnapshot).not.toHaveBeenCalled();
});
