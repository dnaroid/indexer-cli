import { UserService } from "../../src/services/user";

export function userServiceContractTest(): boolean {
	const service = new UserService();
	return Boolean(service);
}