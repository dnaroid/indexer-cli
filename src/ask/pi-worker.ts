import { pathToFileURL } from "node:url";
import { completePiRequest, findPiEntry, type PiRuntimeModule, type PiRequest } from "./pi-runtime.js";

async function main(): Promise<void> {
	try {
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of process.stdin) {
			bytes += chunk.length;
			if (bytes > 256_000) throw new Error();
			chunks.push(chunk);
		}
		const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PiRequest;
		const sdk = await import(pathToFileURL(findPiEntry()).href) as PiRuntimeModule;
		const value = await completePiRequest(request, sdk);
		const output = JSON.stringify({ value });
		if (Buffer.byteLength(output) > 100_000) throw new Error();
		process.stdout.write(output, () => process.exit(0));
	} catch (error) {
		// Never surface provider errors, which can contain credentials or request data.
		const retryable = Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
		process.stdout.write(JSON.stringify({ error: "Pi request failed", retryable }), () => process.exit(0));
	}
}

void main();
