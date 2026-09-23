import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runAskAction } from "../../../src/ask/runner.js";
import type { AskAction } from "../../../src/ask/routes.js";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const action: AskAction = { tool: "context", query: "$(touch injected); --help", target: null, pathPrefix: null };

describe("ask process boundary", () => {
 it.each(["lexical", "symbol"] as const)("does not leak routine read-only snapshot policy for %s search", mode => {
  vi.mocked(spawnSync).mockReturnValue({ stdout: "evidence", stderr: "", status: 0 } as never);
  const result = runAskAction(process.cwd(), "/idx/entry.js", { ...action, tool: "search", mode });
  expect(result.stderr).not.toContain("snapshot without automatic indexing; it may be stale");
  expect(result.failed).toBe(false);
 });
 it("runs fixed argv without a shell using bounded timeout and child marker", () => {
  vi.mocked(spawnSync).mockReturnValue({ stdout: "evidence", stderr: "", status: 0 } as never);
  const result = runAskAction(process.cwd(), "/idx/entry.js", action, 5000);
  expect(result.failed).toBe(false);
  expect(spawnSync).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["/idx/entry.js", "--no-auto-update", "context", "--", action.query]), expect.objectContaining({ shell: false, timeout: 5000, maxBuffer: 256000, env: expect.objectContaining({ IDX_ASK_CHILD: "1" }) }));
 });
 it("preserves partial output while bounding/failing process errors", () => {
  vi.mocked(spawnSync).mockReturnValue({ stdout: "partial", stderr: "WARN stale", status: null, error: new Error("sensitive exception detail") } as never);
  const result = runAskAction(process.cwd(), "/idx/entry.js", action, 999999);
  expect(result.failed).toBe(true); expect(result.stdout).toBe("partial"); expect(result.stderr).toContain("WARN stale");
  expect(result.stderr).not.toContain("sensitive exception detail");
  expect(vi.mocked(spawnSync).mock.calls[0][2]?.timeout).toBeLessThanOrEqual(30000);
 });
 it("rejects symlink targets escaping project before child launch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ask-runner-")); const outside = mkdtempSync(path.join(os.tmpdir(), "ask-outside-")); roots.push(root, outside);
  writeFileSync(path.join(outside, "file.ts"), "secret"); symlinkSync(path.join(outside, "file.ts"), path.join(root, "link.ts"));
  expect(() => runAskAction(root, "/idx/entry.js", { tool: "ast", query: null, target: "link.ts", pathPrefix: null }, 1000)).toThrow(/outside the project/i);
  expect(spawnSync).not.toHaveBeenCalled();
 });
});
