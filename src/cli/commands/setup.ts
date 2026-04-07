import { execSync } from "node:child_process";
import os from "node:os";
import type { Command } from "commander";

const PLATFORM = os.platform();
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

if (!IS_MAC && !IS_LINUX) {
	console.error(
		`Unsupported platform: ${PLATFORM}. Only macOS and Linux are supported.`,
	);
	process.exit(1);
}

function run(cmd: string, opts?: { stdio?: "pipe" | "inherit" }): string {
	return execSync(cmd, {
		stdio: opts?.stdio ?? "pipe",
		encoding: "utf8",
	}).trim();
}

function cmdExists(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

function green(text: string): string {
	return `\x1b[32m${text}\x1b[0m`;
}

function yellow(text: string): string {
	return `\x1b[33m${text}\x1b[0m`;
}

function red(text: string): string {
	return `\x1b[31m${text}\x1b[0m`;
}

interface CheckResult {
	name: string;
	status: "ok" | "installed" | "failed" | "skipped";
	detail?: string;
}

const results: CheckResult[] = [];

// ── Node.js ─────────────────────────────────────────────────────────────

function checkNode(): CheckResult {
	if (!cmdExists("node")) {
		console.log(`  ${yellow("⨯")} Node.js not found. Installing...`);
		try {
			if (IS_MAC && cmdExists("brew")) {
				run("brew install node", { stdio: "inherit" });
			} else if (IS_LINUX && cmdExists("apt-get")) {
				run("sudo apt-get update -qq", { stdio: "inherit" });
				run("sudo apt-get install -y -qq nodejs", { stdio: "inherit" });
			} else {
				return {
					name: "Node.js",
					status: "failed",
					detail: "Install manually: https://nodejs.org/en/download",
				};
			}
		} catch (e) {
			return {
				name: "Node.js",
				status: "failed",
				detail: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	try {
		const version = run("node --version");
		const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);
		if (major >= 18) {
			return { name: "Node.js", status: "ok", detail: version };
		}
		return {
			name: "Node.js",
			status: "failed",
			detail: `${version} found, but 18+ required`,
		};
	} catch {
		return {
			name: "Node.js",
			status: "failed",
			detail: "Failed to detect version",
		};
	}
}

// ── Git ─────────────────────────────────────────────────────────────────

function checkGit(): CheckResult {
	if (!cmdExists("git")) {
		console.log(`  ${yellow("⨯")} git not found. Installing...`);
		try {
			if (IS_MAC && cmdExists("brew")) {
				run("brew install git", { stdio: "inherit" });
			} else if (IS_LINUX && cmdExists("apt-get")) {
				run("sudo apt-get install -y -qq git", { stdio: "inherit" });
			} else {
				return {
					name: "Git",
					status: "failed",
					detail: "Install manually: https://git-scm.com",
				};
			}
		} catch (e) {
			return {
				name: "Git",
				status: "failed",
				detail: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	try {
		const version = run("git --version");
		return { name: "Git", status: "ok", detail: version };
	} catch {
		return {
			name: "Git",
			status: "failed",
			detail: "Failed to detect version",
		};
	}
}

// ── Build tools ─────────────────────────────────────────────────────────

function checkBuildTools(): CheckResult {
	if (IS_MAC) {
		try {
			const path = run("xcode-select -p");
			if (path) {
				return { name: "Build tools (Xcode CLT)", status: "ok", detail: path };
			}
		} catch {
			// xcode-select -p throws when CLT not installed
		}

		console.log(`  ${yellow("⨯")} Xcode CLT not found. Installing...`);
		try {
			run("xcode-select --install", { stdio: "inherit" });
			return {
				name: "Build tools (Xcode CLT)",
				status: "installed",
				detail: "Follow the prompt to complete installation",
			};
		} catch {
			return {
				name: "Build tools (Xcode CLT)",
				status: "failed",
				detail: "Run manually: xcode-select --install",
			};
		}
	}

	if (!(cmdExists("gcc") || cmdExists("cc")) || !cmdExists("make")) {
		console.log(`  ${yellow("⨯")} Build tools not found. Installing...`);
		try {
			if (cmdExists("apt-get")) {
				run("sudo apt-get update -qq", { stdio: "inherit" });
				run("sudo apt-get install -y -qq build-essential", {
					stdio: "inherit",
				});
				return { name: "Build tools (gcc/make)", status: "installed" };
			}
			return {
				name: "Build tools (gcc/make)",
				status: "failed",
				detail: "Install build-essential or equivalent manually",
			};
		} catch (e) {
			return {
				name: "Build tools",
				status: "failed",
				detail: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	try {
		const gccVersion = run("gcc --version | head -1");
		return { name: "Build tools (gcc/make)", status: "ok", detail: gccVersion };
	} catch {
		return { name: "Build tools", status: "ok" };
	}
}

// ── Python (needed by node-gyp for native modules) ──────────────────────

function checkPython(): CheckResult {
	const pythonCmd = cmdExists("python3")
		? "python3"
		: cmdExists("python")
			? "python"
			: null;

	if (pythonCmd) {
		try {
			const version = run(`${pythonCmd} --version`);
			return { name: "Python (for node-gyp)", status: "ok", detail: version };
		} catch {
			// python exists but --version failed, skip
		}
	}

	console.log(`  ${yellow("⨯")} Python not found. Installing...`);
	try {
		if (IS_MAC && cmdExists("brew")) {
			run("brew install python3", { stdio: "inherit" });
		} else if (IS_LINUX && cmdExists("apt-get")) {
			run("sudo apt-get install -y -qq python3", { stdio: "inherit" });
		} else {
			return {
				name: "Python (for node-gyp)",
				status: "failed",
				detail: "Install Python 3 manually",
			};
		}
		return { name: "Python (for node-gyp)", status: "installed" };
	} catch (e) {
		return {
			name: "Python (for node-gyp)",
			status: "failed",
			detail: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

// ── Ollama ──────────────────────────────────────────────────────────────

function checkOllama(): CheckResult {
	if (!cmdExists("ollama")) {
		console.log(`  ${yellow("⨯")} Ollama not found. Installing...`);
		try {
			run("curl -fsSL https://ollama.com/install.sh | sh", {
				stdio: "inherit",
			});
		} catch (e) {
			return {
				name: "Ollama",
				status: "failed",
				detail: `Install failed: ${e instanceof Error ? e.message : String(e)}. Install manually: https://ollama.com`,
			};
		}
	}

	try {
		const version = run("ollama --version");
		return { name: "Ollama", status: "ok", detail: version };
	} catch {
		return { name: "Ollama", status: "ok", detail: "installed" };
	}
}

function ensureOllamaRunning(): CheckResult {
	try {
		const result = run("ollama ps");
		void result;
		return { name: "Ollama daemon", status: "ok", detail: "running" };
	} catch {
		// ollama ps throws when daemon not running
	}

	console.log(`  Starting Ollama daemon...`);
	try {
		run("ollama serve > /dev/null 2>&1 &");
		let attempts = 0;
		while (attempts < 30) {
			try {
				run("ollama ps");
				return {
					name: "Ollama daemon",
					status: "installed",
					detail: "started",
				};
			} catch {
				attempts++;
				execSync("sleep 1", { stdio: "pipe" });
			}
		}
		return {
			name: "Ollama daemon",
			status: "failed",
			detail:
				"Timed out waiting for Ollama to start. Run `ollama serve` manually.",
		};
	} catch (e) {
		return {
			name: "Ollama daemon",
			status: "failed",
			detail: `Failed to start: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

// ── jina-8k model ───────────────────────────────────────────────────────

const BASE_MODEL = "unclemusclez/jina-embeddings-v2-base-code:q5";
const CUSTOM_MODEL = "jina-8k";

function checkJinaModel(): CheckResult {
	try {
		const models = run("ollama list");
		if (models.includes(CUSTOM_MODEL)) {
			return { name: `Model ${CUSTOM_MODEL}`, status: "ok", detail: "pulled" };
		}
	} catch {
		// ollama list failed or model not present
	}

	console.log(`  Pulling base model ${BASE_MODEL} (≈119MB)...`);
	try {
		run(`ollama pull ${BASE_MODEL}`, { stdio: "inherit" });
	} catch (e) {
		return {
			name: `Model ${CUSTOM_MODEL}`,
			status: "failed",
			detail: `Pull failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	console.log(`  Creating ${CUSTOM_MODEL} with num_ctx 8192...`);
	try {
		const tmpdir = run("mktemp -d");
		const modelfile = `${tmpdir}/Modelfile.jina-8k`;

		const content = `FROM ${BASE_MODEL}\nPARAMETER num_ctx 8192\n`;
		execSync(`cat > ${modelfile} << 'MODELEOF'\n${content}MODELEOF`, {
			stdio: "pipe",
			shell: "/bin/bash",
		});
		run(`ollama create ${CUSTOM_MODEL} -f ${modelfile}`, { stdio: "inherit" });
		execSync(`rm -rf ${tmpdir}`, { stdio: "pipe" });

		return { name: `Model ${CUSTOM_MODEL}`, status: "installed" };
	} catch (e) {
		return {
			name: `Model ${CUSTOM_MODEL}`,
			status: "failed",
			detail: `Create failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

// ── Summary ─────────────────────────────────────────────────────────────

function printSummary(): void {
	console.log("");
	console.log(bold("  Setup Summary"));
	console.log("  ─────────────────────────────────────────");

	let allOk = true;
	for (const r of results) {
		const icon =
			r.status === "ok"
				? green("✓")
				: r.status === "installed"
					? green("✓")
					: r.status === "skipped"
						? yellow("○")
						: red("✗");

		const suffix = r.detail ? `  (${r.detail})` : "";
		const label = r.status === "installed" ? `${r.name}  — installed` : r.name;
		console.log(`  ${icon} ${label}${suffix}`);

		if (r.status === "failed") allOk = false;
	}

	console.log("");

	if (!allOk) {
		console.log(
			red(
				"  Some dependencies failed. Resolve the issues above and re-run `indexer-cli setup`.",
			),
		);
		process.exitCode = 1;
	} else {
		console.log(
			green(
				"  All dependencies ready. Run `indexer-cli init` in your project to start.",
			),
		);
	}
}

// ── Main ────────────────────────────────────────────────────────────────

export function registerSetupCommand(program: Command): void {
	program
		.command("setup")
		.description("Check and install all dependencies for indexer-cli")
		.action(() => {
			console.log(bold("\n  indexer-cli dependency setup\n"));
			console.log(`  Platform: ${os.type()} ${os.release()} (${os.arch()})\n`);

			console.log(bold("  Checking system prerequisites..."));

			results.push(checkNode());
			results.push(checkGit());
			results.push(checkBuildTools());
			results.push(checkPython());

			console.log(bold("\n  Checking Ollama & embedding model..."));

			results.push(checkOllama());
			results.push(ensureOllamaRunning());
			results.push(checkJinaModel());

			printSummary();
		});
}
