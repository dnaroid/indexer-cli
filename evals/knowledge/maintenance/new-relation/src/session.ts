export async function loadSessionToken(load: () => Promise<string>): Promise<string> {
	try {
		return await load();
	} catch {
		return await load();
	}
}
