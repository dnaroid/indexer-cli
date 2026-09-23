import { describe, expect, it } from "vitest";
import { ASK_TOOLS, ASK_TOOL_DEFINITIONS, actionArgs, validateAction } from "../../../src/ask/routes.js";

describe("native ask route validation", () => {
 const base = { query: "find auth", target: null, pathPrefix: null };
 it("exposes precisely the read-only tool set", () => {
  expect(ASK_TOOLS).toEqual(["context", "search", "architecture", "structure", "ast", "explain", "deps", "audit"]);
 });
 it.each(["shell", "wiki", "index", "ask", "fallbackAction"]) ("rejects unknown tool %s", tool => {
  expect(() => validateAction({ tool, ...base })).toThrow();
 });
 it.each(["../secret", "/etc/passwd", "C:\\secret", "--help", "a/../../secret", "bad\npath"]) ("rejects unsafe path %s", target => {
  expect(() => validateAction({ tool: "ast", query: null, target, pathPrefix: null })).toThrow();
 });
 it("requires base fields and rejects extras/control chars", () => {
  expect(validateAction({ tool: "context", query: "x" })).toMatchObject({ pathPrefix: null, target: null });
  expect(() => validateAction({ tool: "context", ...base, argv: ["--help"] })).toThrow();
  expect(() => validateAction({ tool: "context", ...base, query: "x\u0000" })).toThrow();
 });
 it("validates optional native arguments and only emits applicable ones", () => {
  expect(validateAction({ tool: "search", ...base, mode: "hybrid" })).toMatchObject({ tool: "search", mode: "hybrid" });
  expect(() => validateAction({ tool: "search", ...base, mode: "unsafe" })).toThrow();
  expect(() => validateAction({ tool: "context", ...base, direction: "incoming" })).toThrow();
  expect(() => validateAction({ tool: "deps", query: null, target: "src/a.ts", pathPrefix: null, direction: "incoming", cursor: 10 })).toThrow();
  expect(() => validateAction({ tool: "deps", query: null, target: "src/a.ts", pathPrefix: null, direction: "callers", mode: "calls" })).not.toThrow();
  expect(actionArgs({ tool: "structure", query: null, target: null, pathPrefix: "src", cursor: 10 })).toContain("10");
 });
 it("accepts tool-minimal arguments, normalizes omitted unused fields, and publishes narrow schemas", () => {
  expect(validateAction({ tool: "architecture" })).toMatchObject({ query: null, target: null, pathPrefix: null, cursor: null });
  expect(validateAction({ tool: "context", query: "overview" })).toMatchObject({ target: null, pathPrefix: null, query: "overview" });
  const architecture = ASK_TOOL_DEFINITIONS.find(x => x.name === "architecture")!;
  expect(Object.keys(architecture.parameters.properties)).toEqual(["pathPrefix"]);
  expect(() => validateAction({ tool: "architecture", query: "x" })).toThrow(/Invalid ask query/);
 });
 it("builds argv only from validated data and never interprets query as flags", () => {
  const args = actionArgs({ tool: "search", query: "--help; $(touch pwned)", target: null, pathPrefix: null, mode: "lexical" });
  expect(args).toContain("--"); expect(args.at(-1)).toBe("--help; $(touch pwned)"); expect(args).toContain("--mode");
 });
 it("rejects bare files for explain before spawning a process, without rejecting valid symbols", () => {
  for (const target of ["src/knowledge/context.ts", "src\\knowledge\\context.ts", "package.json", "tsconfig.json", "config.yaml", "README.md", "schema.sql"]) {
   expect(() => validateAction({ tool: "explain", target })).toThrow(/path\/to\/file::symbol/);
  }
  expect(validateAction({ tool: "explain", target: "src/knowledge/context.ts::KnowledgeContextEngine" }).target).toBe("src/knowledge/context.ts::KnowledgeContextEngine");
  expect(validateAction({ tool: "explain", target: "auth.login" }).target).toBe("auth.login");
  expect(validateAction({ tool: "explain", target: "package.version" }).target).toBe("package.version");
  expect(validateAction({ tool: "ast", target: "src/knowledge/context.ts" }).target).toBe("src/knowledge/context.ts");
  expect(ASK_TOOL_DEFINITIONS.find(x => x.name === "explain")?.description).toContain("never a bare file path");
 });
});
