import { createSession, type Session } from "../auth/session";
import { AuthError, ValidationError } from "../utils/errors";
import type { Logger } from "../utils/logger";

export type User = {
	id: string;
	name: string;
	email: string;
	roles: string[];
};

export type UserInput = {
	name: string;
	email: string;
	password: string;
	roles: string[];
};

export function validateInput(value: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new ValidationError("Input cannot be empty");
	}
	return normalized;
}

export function validateUser(input: UserInput): UserInput {
	const email = validateInput(input.email).toLowerCase();
	const name = validateInput(input.name);
	if (!email.includes("@")) {
		throw new ValidationError("User email must include @", { field: "email" });
	}
	if (input.password.length < 12) {
		throw new AuthError("Password policy rejected the provided credentials");
	}
	if (input.roles.length === 0) {
		throw new ValidationError("At least one role is required", { field: "roles" });
	}
	return { ...input, email, name, roles: [...new Set(input.roles)] };
}

export function createUser(input: UserInput, logger: Logger): { user: User; session: Session } {
	const validated = validateUser(input);
	const user: User = {
		id: validated.email.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
		name: validated.name,
		email: validated.email,
		roles: validated.roles,
	};
	const session = createSession(user);
	logger.info("User account created", { userId: user.id, sessionId: session.id });
	return { user, session };
}

export class UserService {
	private readonly users = new Map<string, User>();

	constructor(private readonly logger: Logger) {}

	register(input: UserInput): { user: User; session: Session } {
		const created = createUser(input, this.logger);
		this.users.set(created.user.id, created.user);
		return created;
	}

	list(): User[] {
		return Array.from(this.users.values()).sort((left, right) => left.email.localeCompare(right.email));
	}

	findById(userId: string): User | undefined {
		return this.users.get(userId);
	}
}