import { loadSessionToken } from "./session.js";

export async function refreshSession(load: () => Promise<string>): Promise<string> {
	return loadSessionToken(load);
}
