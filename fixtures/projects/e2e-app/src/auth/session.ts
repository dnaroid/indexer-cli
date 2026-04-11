export type Session = {
	id: string;
	userId: string;
	token: string;
	roles: string[];
	expiresAt: Date;
};

type SessionUser = {
	id: string;
	email: string;
	roles: string[];
};

export function createSession(user: SessionUser): Session {
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 8);
	const payload = [user.id, user.email.toLowerCase(), expiresAt.getTime()].join(":");
	const token = Buffer.from(payload).toString("base64url");

	return {
		id: `auth-${user.id}`,
		userId: user.id,
		token,
		roles: [...user.roles],
		expiresAt,
	};
}

export function validateToken(token: string): boolean {
	if (!token || token.length < 16) {
		return false;
	}

	try {
		const decoded = Buffer.from(token, "base64url").toString("utf8");
		const parts = decoded.split(":");
		if (parts.length !== 3) {
			return false;
		}
		const expiresAt = Number(parts[2]);
		return Number.isFinite(expiresAt) && expiresAt > Date.now();
	} catch {
		return false;
	}
}