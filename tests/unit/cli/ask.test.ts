import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({ answer: vi.fn(), model: vi.fn(), run: vi.fn(), root: vi.fn() }));
vi.mock("../../../src/ask/engine.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/ask/engine.js")>(), answerAsk: mocks.answer }));
vi.mock("../../../src/ask/configured-model.js", () => ({ createConfiguredAskModel: mocks.model }));
vi.mock("../../../src/ask/runner.js", () => ({ runAskAction: mocks.run }));
vi.mock("../../../src/cli/project-root.js", () => ({ resolveInitializedProjectRoot: mocks.root }));
import { registerAskCommand } from "../../../src/cli/commands/ask.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe("ask CLI", () => {
 it("registers budget but no offline or pagination flags", () => {
  const program = new Command(); registerAskCommand(program);
  const command = program.commands.find(item => item.name() === "ask")!;
  expect(command.options.map(option => option.long)).toContain("--budget");
  expect(command.options.map(option => option.long)).not.toContain("--no-llm");
  expect(command.options.map(option => option.long)).not.toContain("--cursor");
 });
 it("passes initialized root through model and runner and prints notices", async () => {
  mocks.root.mockReturnValue({ projectRoot: "/initialized", notice: "using initialized project" });
  mocks.model.mockReturnValue({ turn: vi.fn() });
  mocks.answer.mockResolvedValue({ text: "Answer [E1]", evidence: [{ id: "E1", text: "source" }], notices: [], failed: false, turns: 2, calls: 1 });
  const program = new Command(); registerAskCommand(program); program.exitOverride();
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await program.parseAsync(["node", "idx", "ask", "question", "--budget", "600"]);
  expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ question: "question", projectRoot: "/initialized", budget: 600 }));
  expect(mocks.answer.mock.calls.at(-1)![0].run).toEqual(expect.any(Function));
  expect(write.mock.calls.flat()[0]).toContain("using initialized project");
  write.mockRestore();
 });
 it("rejects invalid budget and exits nonzero when answer cannot be produced", async () => {
  mocks.root.mockReturnValue({ projectRoot: "/repo", notice: "" }); mocks.model.mockReturnValue({});
  const program = new Command(); registerAskCommand(program); program.exitOverride();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await program.parseAsync(["node", "idx", "ask", "question", "--budget", "199"]);
  expect(mocks.answer).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  process.exitCode = 0; mocks.answer.mockResolvedValue({ text: "guide", notices: [], failed: true });
  await program.parseAsync(["node", "idx", "ask", "question"]);
  expect(process.exitCode).toBe(1); error.mockRestore(); process.exitCode = 0;
 });
 it("bounds combined provider and retrieval notices outside the per-turn token budget", async () => {
  mocks.root.mockReturnValue({ projectRoot: "/repo", notice: "" });
  mocks.model.mockImplementation((onNotice: (message: string) => void) => {
   for (let i = 0; i < 30; i++) onNotice(`ASK retry: attempt ${i}`);
   return {};
  });
  mocks.answer.mockResolvedValue({ text: "Answer [E1]\n\nSources:\n[E1] src/a.ts:1-8", notices: ["WARN actual degradation"], failed: false });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const program = new Command(); registerAskCommand(program);
  await program.parseAsync(["node", "idx", "ask", "question"]);
  const output = String(write.mock.calls[0][0]);
  expect(output).toContain("[E1] src/a.ts:1-8");
  expect(output).toContain("WARN actual degradation");
  expect(output).toContain("additional diagnostics omitted");
  expect(Buffer.byteLength(output)).toBeLessThan(1300);
  write.mockRestore();
 });
});
