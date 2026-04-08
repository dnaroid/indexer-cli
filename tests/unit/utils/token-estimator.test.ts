import { describe, expect, it } from "vitest";
import { TokenEstimator } from "../../../src/utils/token-estimator.js";

describe("TokenEstimator", () => {
	const estimator = new TokenEstimator();

	it("returns 0 for an empty string", () => {
		expect(estimator.estimate("")).toBe(0);
	});

	it("returns 0 for a whitespace-only string", () => {
		expect(estimator.estimate("   \n\t  ")).toBe(0);
	});

	it("returns 1 for a single character", () => {
		expect(estimator.estimate("a")).toBe(1);
	});

	it("returns 1 for four characters", () => {
		expect(estimator.estimate("abcd")).toBe(1);
	});

	it("returns 2 for five characters", () => {
		expect(estimator.estimate("abcde")).toBe(2);
	});

	it("estimates large text by rounding up length divided by four", () => {
		const text = "a".repeat(10_000);

		expect(estimator.estimate(text)).toBe(2500);
	});

	it("trims leading and trailing whitespace before estimation", () => {
		expect(estimator.estimate("  abcde  ")).toBe(2);
		expect(estimator.estimate("  abcd  ")).toBe(1);
	});
});
