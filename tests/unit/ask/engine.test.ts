import { describe, expect, it, vi } from "vitest";
import { answerAsk } from "../../../src/ask/engine.js";
import type { AskModel, AskTurn } from "../../../src/ask/model.js";
import type { AskAction } from "../../../src/ask/routes.js";

const source = "Implementation: (1) C src/auth.ts:1-8\nexport function authorized() { return true; }";
const call = (id: string, name = "context", arguments_: unknown = { query: "auth", target: null, pathPrefix: null }) => ({ id, name, arguments: arguments_ });
const turn = (text = "", toolCalls: AskTurn["toolCalls"] = []): AskTurn => ({ text, toolCalls });
function model(...turns: AskTurn[]): AskModel { return { turn: vi.fn(async () => turns.shift() ?? turn()) }; }
const run = vi.fn((_a: AskAction, _t: number) => ({ stdout: source, stderr: "", failed: false }));
const opts = (m: AskModel, overrides = {}) => ({ question: "How does auth work?", projectRoot: "/repo", model: m, run, ...overrides });

describe("native ask tool loop", () => {
 it("retrieves evidence iteratively and accepts cited final response", async () => {
  run.mockClear();
  const m = model(turn("", [call("1")]), turn("Authorization is implemented here [E1]."));
  const result = await answerAsk(opts(m));
  expect(result.text).toContain("[E1]"); expect(result.evidence[0].id).toBe("E1");
  expect(result.turns).toBe(2); expect(result.calls).toBe(1); expect(run).toHaveBeenCalledOnce();
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages.at(-1)).toMatchObject({ role: "tool", id: "1" });
 });
 it("rejects unknown and malformed tool calls without executing them and returns each result", async () => {
  run.mockClear();
  const m = model(turn("", [call("a", "shell", {}), call("b", "search", { query: "x", target: null, pathPrefix: null, extra: 1 })]), turn("No repository evidence was available."));
  const result = await answerAsk(opts(m));
  expect(run).not.toHaveBeenCalled(); expect(result.failed).toBe(true);
  const messages = (m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages;
  expect(messages.slice(-2).map((x: {role:string;id?:string}) => [x.role,x.id])).toEqual([["tool","a"],["tool","b"]]);
 });
 it("requires nonempty final text and valid evidence citations", async () => {
  for (const response of [turn(""), turn("Claim without citation"), turn("Wrong source [E9].")]) {
   const result = await answerAsk(opts(model(turn("", [call("x")]), response)));
   expect(result.failed).toBe(true); expect(result.text).toMatch(/could not|configure|idx search/i);
  }
 });
 it("does not treat unsupported stdout as evidence or allow uncited finals", async () => {
  const m = model(turn("", [call("x")] ), turn("Unsupported [E1]."));
  const result = await answerAsk(opts(m, { run: () => ({ stdout: "plain unsupported output", stderr: "", failed: false }) }));
  expect(result.evidence).toEqual([]); expect(result.failed).toBe(true);
 });
 it("preserves retrieval warnings/errors and permits a cited partial answer", async () => {
  const result = await answerAsk(opts(model(turn("", [call("x")]), turn("Partial finding [E1].")), { run: () => ({ stdout: `${source}\nTRUNC omitted=4\nNEXT idx structure --cursor 10`, stderr: "index warning", failed: true }) }));
  expect(result.text).toContain("[E1]"); expect(result.failed).toBe(true);
  expect(result.notices.join("\n")).toMatch(/index warning|retrieval failed/i);
 });
 it("sanitizes runner errors even when their message resembles validation feedback", async () => {
  const result = await answerAsk(opts(model(turn("", [call("x")] ), turn("Partial [E1].")), { run: () => { throw Error("Invalid token=credential-secret"); } }));
  expect(JSON.stringify(result)).not.toContain("credential-secret");
 });
 it("shows actionable safe validation feedback and deduplicates identical source citations", async () => {
  const m = model(turn("", [call("x", "search", { query: "auth", mode: "modules" })]), turn("No evidence available."));
  const result = await answerAsk(opts(m));
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages.at(-1).text).toMatch(/Invalid tool arguments: Invalid ask retrieval mode/);
  expect(result.failed).toBe(true);
  const duplicated = await answerAsk(opts(model(turn("", [call("1"), call("2")]), turn("Finding [E1] and [E2]."))));
  expect(duplicated.text.match(/Sources:/g)).toHaveLength(1);
  expect(duplicated.text).toContain("[E1, E2]");
  expect(duplicated.text).not.toContain("score:");
  expect(duplicated.text).toContain("src/auth.ts:");
 });
 it("deduplicates read-only snapshot notices and avoids verbose source previews", async () => {
  const noisy = "ASK snapshot: indexed retrieval uses the existing snapshot without automatic indexing; it may be stale. Run idx index explicitly to refresh.\nIDX stale reason=ask-read-only action=Run-idx-index-explicitly-to-refresh. ms=0";
  const result = await answerAsk(opts(model(turn("", [call("1"), call("2")]), turn("Finding [E1].")), { run: () => ({ stdout: source, stderr: noisy, failed: false }) }));
  expect(result.notices.join("\n")).not.toMatch(/snapshot|may be stale/i);
 });
 it("omits routine stdout policy notices but preserves actual stale reasons", async () => {
  const stdout = `${source}\nIDX stale reason=ask-read-only action=Run-idx-index-explicitly-to-refresh. ms=0\nIDX stale reason=files-changed action=Run-idx-index`;
  const result = await answerAsk(opts(model(turn("", [call("1")]), turn("Finding [E1].")), { run: () => ({ stdout, stderr: "", failed: false }) }));
  expect(result.notices.join("\n")).not.toContain("reason=ask-read-only");
  expect(result.notices.join("\n")).toContain("reason=files-changed");
 });
 it("cites authoritative headers, not unrelated paths inside previews", async () => {
  const responses = [
   ["search", { query: "auth" }, "src/auth.ts:2-6 (score: 0.9)\nother.ts:99-100 is discussed", "src/auth.ts:2-6"],
   ["explain", { target: "src/auth.ts::authorized" }, "File:   src/auth.ts (lines 2-6)\nBody preview:\nother.ts:99-100", "src/auth.ts:2-6"],
   ["ast", { target: "src/auth.ts" }, "AST src/auth.ts language=typescript nodes=2 maxDepth=4\nmethod:2-6", "src/auth.ts"],
   ["deps", { target: "src/auth.ts" }, "M src/auth.ts mode=module-imports\n-> other.ts", "src/auth.ts"],
   ["structure", { pathPrefix: "src" }, "auth.ts — method authorized\nother.ts", "src/auth.ts"],
  ] as const;
  for (const [name, args, stdout, expected] of responses) {
   const action = { query: null, target: null, pathPrefix: null, ...args };
   const result = await answerAsk(opts(model(turn("", [call("1", name, action)]), turn("Finding [E1].")), { run: () => ({ stdout, stderr: "", failed: false }) }));
   expect(result.text).toContain(`[E1] ${expected}`);
   expect(result.text.split("Sources:")[1]).not.toMatch(/other\.ts|score:|method authorized/);
  }
 });
 it("deduplicates identical multiline stderr across tools while retaining each failure", async () => {
  const stderr = "WARN index unavailable\n  detail: retry explicitly";
  const result = await answerAsk(opts(model(turn("", [call("1"), call("2", "search", { query: "auth" })]), turn("Finding [E1].")), {
   run: () => ({ stdout: source, stderr, failed: true }),
  }));
  expect(result.notices.filter(item => item.includes(stderr))).toHaveLength(1);
  expect(result.notices.join("\n")).toContain("idx context] retrieval failed");
  expect(result.notices.join("\n")).toContain("idx search] retrieval failed");
 });
 it("exposes full architecture diagnostics to the model without unrelated final noise", async () => {
  const m = model(turn("", [call("1", "architecture", {})]), turn("Cycle noted [E1]."));
  const result = await answerAsk(opts(m, { run: () => ({ stdout: "File stats by language\n  ts: 2\nCYCLE sev=high a.ts <-> b.ts\n  a.ts -> b.ts\n  fix=break cycle\nUNRESOLVED sev=med a.ts -> missing\nActions:\n1. inspect a.ts", stderr: "", failed: false }) }));
  const observation = (m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages.at(-1).text;
  expect(observation).toContain("fix=break cycle"); expect(observation).toContain("1. inspect a.ts");
  expect(result.notices.join("\n")).not.toContain("dependency cycles");
  expect(result.notices.join("\n")).not.toContain("inspect a.ts");
  expect(result.text.split("Sources:")[1]).toContain("idx architecture");
 });
 it("uses safe guide on missing or failed model and does not expose provider secrets", async () => {
  const absent = await answerAsk({ question: "q", projectRoot: "/repo", run });
  expect(absent.text).toMatch(/idx search/i); expect(absent.failed).toBe(true);
  const broken = await answerAsk(opts({ turn: async () => { throw Error("credential-secret"); } }));
  expect(broken.text).toMatch(/idx search/i); expect(JSON.stringify(broken)).not.toContain("credential-secret");
 });
 it("validates engine budgets", async () => {
  for (const budget of [199, 20001]) await expect(answerAsk(opts(model(turn()), { budget }))).rejects.toThrow();
 });
 it("recovers from an invalid explain target and a failed retrieval without failing a later grounded answer", async () => {
  const invoked = vi.fn((action: AskAction) => ({ stdout: action.tool === "context" ? source : "", stderr: action.tool === "context" ? "" : "temporary retrieval error", failed: action.tool !== "context" }));
  const m = model(turn("", [call("a", "explain", { target: "src/auth.ts" }), call("b", "search", { query: "missing" })]), turn("", [call("c")]), turn("Authorization [E1]."));
  const result = await answerAsk(opts(m, { run: invoked }));
  expect(invoked).toHaveBeenCalledTimes(2);
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages.find((item: { id?: string }) => item.id === "a").text).toMatch(/bare file use ast or search/);
  expect(result.failed).toBe(false);
  expect(result.notices.join("\n")).not.toMatch(/temporary retrieval error|retrieval failed/);
  expect(result.text).toContain("src/auth.ts:1-8");
 });
 it("requests focused retrieval without a mandatory bootstrap and returns compact notices", async () => {
  const m = model(turn("", [call("a")]), turn("Answer [E1]."));
  const result = await answerAsk(opts(m, { run: () => ({ stdout: `${source}\nRead next: src/other.ts:1-10\nTRUNC budget=4000 omitted=2 clipped=0 estimated-used=500`, stderr: "", failed: false }) }));
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[0][0].instructions).toMatch(/No mandatory bootstrap.*narrow context\/search/s);
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[0][0].instructions).toContain("A filename mentioned in a document does not establish that the file or subsystem exists here.");
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toMatch(/ASK incomplete: indexed retrieval omitted, clipped, or hid results/);
  expect(result.notices.join("\n")).not.toMatch(/TRUNC budget|Read next:/);
 });
 it("deduplicates upstream truncation while suppressing routine paging and zero-count markers", async () => {
  const result = await answerAsk(opts(model(turn("", [call("a"), call("b", "structure", {})]), turn("Answer [E1].")), {
   run: (action: AskAction) => ({ stdout: action.tool === "context"
    ? `${source}\nTRUNC budget=4000 omitted=0 clipped=1\nRead next: more`
    : "src/\n  auth.ts — method authorized\nTRUNC hidden=3 cursor=20\nNEXT idx structure --cursor 20", stderr: "", failed: false }),
  }));
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toMatch(/ASK incomplete: indexed retrieval/);
  const complete = await answerAsk(opts(model(turn("", [call("c")]), turn("Answer [E1].")), {
   run: () => ({ stdout: `${source}\nTRUNC budget=4000 omitted=0 clipped=0\nRead next: more`, stderr: "", failed: false }),
  }));
  expect(complete.notices).toEqual([]);
 });
 it("keeps upstream incompleteness visible when other diagnostics fill the report", async () => {
  const result = await answerAsk(opts(model(turn("", [call("a")]), turn("Answer [E1].")), {
   run: () => ({ stdout: `${source}\n${Array.from({ length: 8 }, (_, i) => `WARN ${i} ${"detail ".repeat(15)}`).join("\n")}\nTRUNC omitted=2`, stderr: "", failed: false }),
  }));
  expect(result.notices[0]).toMatch(/ASK incomplete: indexed retrieval/);
  expect(result.notices.join("\n")).toMatch(/additional diagnostics omitted/);
 });
 it("does not advise credentials for an unanswerable question with no indexed evidence", async () => {
  const result = await answerAsk(opts(model(turn("", [call("a")]), turn("I cannot substantiate this.")), { run: () => ({ stdout: "WARN no-results", stderr: "", failed: false }) }));
  expect(result.failed).toBe(true);
  expect(result.text).toMatch(/Insufficient indexed evidence/);
  expect(result.text).not.toMatch(/configure|credential|\.env/i);
 });
 it("distinguishes provider interruption after a retrieval miss from exhausted indexed evidence", async () => {
  let turns = 0;
  const m: AskModel = { turn: async () => {
   if (turns++ === 0) return turn("", [call("a")]);
   throw Error("provider credential-secret");
  } };
  const result = await answerAsk(opts(m, { run: () => ({ stdout: "WARN no-results", stderr: "retrieval unavailable", failed: true }) }));
  expect(result.failed).toBe(true);
  expect(result.text).toMatch(/model response was interrupted/);
  expect(result.text).not.toMatch(/Insufficient indexed evidence/);
  expect(result.text).toMatch(/idx search.*idx context/);
  expect(result.notices.join("\n")).toMatch(/retrieval unavailable/);
  expect(JSON.stringify(result)).not.toContain("credential-secret");
 });
 it("does not feed the model routine policy through stdout, even with no evidence", async () => {
  const m = model(turn("", [call("a")]), turn("No evidence."));
  const policy = "IDX stale reason=ask-read-only action=Run-idx-index-explicitly-to-refresh. ms=0";
  await answerAsk(opts(m, { run: () => ({ stdout: policy, stderr: "", failed: false }) }));
  expect((m.turn as ReturnType<typeof vi.fn>).mock.calls[1][0].messages.at(-1).text).not.toContain("ask-read-only");
 });
 it("bounds final diagnostics without clipping cited source pointers or answer text", async () => {
  const m = model(turn("", [call("a")]), turn("Complete finding [E1]."));
  const stderr = Array.from({ length: 30 }, (_, i) => `WARN ${i} ${"details ".repeat(7)}`).join("\n");
  const result = await answerAsk(opts(m, { run: () => ({ stdout: source, stderr, failed: false }) }));
  expect(result.text).toContain("Complete finding [E1].\n\nSources:\n[E1] src/auth.ts:1-8");
  expect(Buffer.byteLength(result.notices.join("\n"))).toBeLessThan(1100);
  expect(result.notices.join("\n")).toContain("additional diagnostics omitted");
 });
});
