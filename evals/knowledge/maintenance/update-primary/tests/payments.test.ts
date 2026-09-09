import { paymentAttemptKey } from "../src/payments.js";

if (paymentAttemptKey("pay-1", 1) !== paymentAttemptKey("pay-1", 2)) {
	throw new Error("payment retries must reuse the same idempotency key");
}
