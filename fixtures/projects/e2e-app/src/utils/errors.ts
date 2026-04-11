export class AppError extends Error {
	constructor(message: string, public readonly code: string, public readonly details?: Record<string, unknown>) {
		super(message);
		this.name = new.target.name;
	}
}

export class NotFoundError extends AppError {
	constructor(resource: string, identifier: string) {
		super(`${resource} was not found`, "NOT_FOUND", { identifier });
	}
}

export class ValidationError extends AppError {
	constructor(message: string, details?: Record<string, unknown>) {
		super(message, "VALIDATION_ERROR", details);
	}
}

export class AuthError extends AppError {
	constructor(message: string, details?: Record<string, unknown>) {
		super(message, "AUTH_ERROR", details);
	}
}