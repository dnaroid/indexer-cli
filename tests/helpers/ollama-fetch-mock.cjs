// Preload in CLI subprocesses: runCLI uses execFileSync, so Vitest mocks cannot
// intercept the child's fetch calls. Reject all unexpected network requests.
globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url === "http://127.0.0.1:1/api/version") {
		return new Response(JSON.stringify({ version: "test" }), { status: 200 });
	}
	if (url === "http://127.0.0.1:1/api/embed") {
		const { input: texts } = JSON.parse(init.body);
		return new Response(JSON.stringify({ embeddings: texts.map(() => Array(768).fill(0.01)) }), { status: 200 });
	}
	throw new Error(`Unexpected fetch in isolated index test: ${url}`);
};
