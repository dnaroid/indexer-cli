import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AskCommandResult } from "./evidence.js";
import { actionArgs, type AskAction } from "./routes.js";

export function runAskAction(projectRoot: string, entry: string, action: AskAction, timeoutMs = 30_000): AskCommandResult {
	const args = actionArgs(action);
	if (timeoutMs <= 0) throw new Error("Ask retrieval deadline exceeded");
	for (const target of [action.target?.split("::")[0], action.pathPrefix]) {
		if (!target) continue;
		const absolute = path.resolve(projectRoot, target);
		if (!existsSync(absolute)) continue;
		const relative = path.relative(realpathSync(projectRoot), realpathSync(absolute));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Ask target resolves outside the project");
	}
	const result = spawnSync(process.execPath, [...process.execArgv, path.resolve(entry), "--no-auto-update", ...args], {
		cwd: projectRoot, env: { ...process.env, IDX_ASK_CHILD: "1", NO_COLOR: "1" },
		encoding: "utf8", timeout: Math.min(30_000, timeoutMs), maxBuffer: 256_000, shell: false,
	});
	const failed = Boolean(result.error || result.signal || result.status !== 0);
	return {
		stdout: result.stdout ?? "",
		stderr: (result.stderr ?? "") + (result.error ? "\nAsk retrieval hit a process/time/output limit; captured output may be incomplete. Run the explicit command with a narrower scope.\n" : ""),
		failed,
	};
}
