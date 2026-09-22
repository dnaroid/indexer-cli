import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	initialize: vi.fn(), close: vi.fn(), snapshot: vi.fn(), refresh: vi.fn(),
}));
vi.mock("../../../src/cli/project-root.js", () => ({
	resolveInitializedProjectRoot: () => ({ projectRoot: "/project" }),
}));
vi.mock("../../../src/core/config.js", () => ({ config: { load: vi.fn() } }));
vi.mock("../../../src/core/logger.js", () => ({ initLogger: vi.fn() }));
vi.mock("../../../src/core/snapshot-retention.js", () => ({
	withSnapshotReadLease: async (_root: string, action: () => Promise<unknown>) => action(),
}));
vi.mock("../../../src/cli/commands/ensure-indexed.js", () => ({ ensureIndexed: mocks.refresh }));
vi.mock("../../../src/storage/sqlite.js", () => ({
	SqliteMetadataStore: class {
		initialize = mocks.initialize;
		close = mocks.close;
		getLatestCompletedSnapshot = mocks.snapshot;
	},
}));
vi.mock("../../../src/knowledge/service.js", () => ({ KnowledgeService: class {} }));

import { withWikiRuntime } from "../../../src/cli/commands/wiki-runtime.js";

describe("wiki runtime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.initialize.mockResolvedValue(undefined);
		mocks.close.mockResolvedValue(undefined);
		mocks.snapshot.mockResolvedValue({ id: "completed" });
		mocks.refresh.mockResolvedValue({ status: "noop", ms: 0 });
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("does not auto-index metadata maintenance", async () => {
		await expect(withWikiRuntime(async (runtime) => runtime.snapshotId)).resolves.toBe("completed");
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("does not use an existing snapshot after refresh failure", async () => {
		mocks.refresh.mockResolvedValue({ status: "failed", reason: "embedding provider unavailable", ms: 1 });
		await expect(withWikiRuntime(async (value) => value, { refresh: true })).rejects.toThrow("embedding provider unavailable");
	});

	it("does not fabricate a snapshot when refresh fails on a new project", async () => {
		mocks.snapshot.mockResolvedValue(null);
		mocks.refresh.mockResolvedValue({ status: "failed", reason: "offline", ms: 1 });
		const action = vi.fn();
		await expect(withWikiRuntime(action, { refresh: true })).rejects.toThrow("offline");
		expect(action).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("propagates descriptive lock timeout diagnostics rather than just the reason code", async () => {
		const message = "Timed out waiting for another indexing process; existing data may be stale. Retry after it finishes.";
		mocks.refresh.mockResolvedValue({ status: "failed", reason: "lock-held", message, ms: 10_000 });
		const action = vi.fn();
		await expect(withWikiRuntime(action, { refresh: true })).rejects.toThrow(message);
		expect(action).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("closes the database when an action fails", async () => {
		await expect(withWikiRuntime(async () => { throw new Error("rejected receipt"); })).rejects.toThrow("rejected receipt");
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});
