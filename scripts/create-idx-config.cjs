#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function globalConfigPath(env = process.env, home = os.homedir()) {
	const xdg = env.XDG_CONFIG_HOME;
	const root = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
	return path.join(root, "idx", ".env");
}

function existingConfig(target) {
	try {
		const stat = fs.lstatSync(target);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe configuration file");
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function ensureGlobalConfig(env = process.env, home = os.homedir()) {
	const target = globalConfigPath(env, home);
	const directory = path.dirname(target);
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const directoryStat = fs.lstatSync(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
			throw new Error("Unsafe configuration directory");
		}
		if (existingConfig(target)) return target;
		// Read the packaged template before reserving the destination, never user configuration.
		const template = fs.readFileSync(path.join(__dirname, "..", "docs", "templates", "idx.env"));
		const temporary = path.join(directory, `.env-${randomUUID()}.tmp`);
		const fd = fs.openSync(temporary, "wx", 0o600);
		try {
			try {
				fs.writeFileSync(fd, template);
			} finally {
				fs.closeSync(fd);
			}
			// Publish only complete content, without replacing a concurrent creator's file.
			try {
				fs.linkSync(temporary, target);
			} catch (error) {
				if (error.code !== "EEXIST" || !existingConfig(target)) throw error;
			}
		} finally {
			fs.unlinkSync(temporary);
		}
		return target;
	} catch {
		throw new Error("Unable to create optional idx configuration");
	}
}

function reportGlobalConfig(env = process.env, home = os.homedir()) {
	try {
		const target = ensureGlobalConfig(env, home);
		console.log(`Global idx configuration: ${target} (existing files preserved; uncomment settings to enable)`);
	} catch {
		console.warn(`Warning: could not create optional idx configuration at ${globalConfigPath(env, home)}. Check permissions and ensure the directory and file are regular, not symlinks; then run idx doctor.`);
	}
}

module.exports = { globalConfigPath, ensureGlobalConfig, reportGlobalConfig };

if (require.main === module) reportGlobalConfig();
