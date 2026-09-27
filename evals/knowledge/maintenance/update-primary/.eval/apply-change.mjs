import { writeFile } from "node:fs/promises";

await writeFile(
	"src/payments.ts",
	[
		"export function paymentAttemptKey(paymentId: string, attempt: number): string {",
		"\treturn `${paymentId}:attempt:${attempt}`;",
		"}",
		"",
	].join("\n"),
	"utf8",
);

await writeFile(
	"tests/payments.test.ts",
	[
		'import { paymentAttemptKey } from "../src/payments.js";',
		"",
		'if (paymentAttemptKey("pay-1", 1) === paymentAttemptKey("pay-1", 2)) {',
		'\tthrow new Error("each payment attempt must use a fresh idempotency key");',
		"}",
		"",
	].join("\n"),
	"utf8",
);
