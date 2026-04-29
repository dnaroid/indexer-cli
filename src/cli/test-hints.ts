import path from "node:path";
import type { DependencyRecord, FileRecord } from "../core/types.js";
import { isTestFile } from "../engine/searcher.js";

export type TestHintReason = "direct" | "related-name" | "related-path";

export interface TestHint {
	testPath: string;
	targetPath: string;
	reason: TestHintReason;
	score: number;
}

export interface FindNearestTestsOptions {
	targetPaths: string[];
	files: FileRecord[];
	dependencies?: DependencyRecord[];
	maxTests?: number;
}

const IGNORED_PATH_TOKENS = new Set([
	"src",
	"lib",
	"app",
	"test",
	"tests",
	"spec",
	"specs",
	"unit",
	"integration",
	"e2e",
	"__tests__",
	"__test__",
]);

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function fileStem(filePath: string): string {
	return path
		.basename(filePath)
		.replace(/\.[^.]+$/, "")
		.replace(/\.(test|spec)$/i, "")
		.toLowerCase();
}

function pathTokens(filePath: string): Set<string> {
	const withoutExtension = filePath.replace(/\.[^.]+$/, "");
	const parts = withoutExtension
		.split(/[\\/_.-]+/)
		.map((part) => part.toLowerCase())
		.filter((part) => part.length > 1 && !IGNORED_PATH_TOKENS.has(part));
	return new Set(parts);
}

function sharedTokenCount(left: Set<string>, right: Set<string>): number {
	let count = 0;
	for (const token of left) {
		if (right.has(token)) count += 1;
	}
	return count;
}

function relationFromNames(testPath: string, targetPath: string): TestHint | null {
	const testStem = fileStem(testPath);
	const targetStem = fileStem(targetPath);
	if (testStem && targetStem && (testStem === targetStem || testStem.includes(targetStem))) {
		return {
			testPath,
			targetPath,
			reason: "related-name",
			score: 80,
		};
	}

	const shared = sharedTokenCount(pathTokens(testPath), pathTokens(targetPath));
	if (shared > 0) {
		return {
			testPath,
			targetPath,
			reason: "related-path",
			score: 40 + shared,
		};
	}

	return null;
}

export function findNearestTests(options: FindNearestTestsOptions): TestHint[] {
	const maxTests = options.maxTests ?? 3;
	const targetPaths = uniqueSorted(options.targetPaths).filter((filePath) => !isTestFile(filePath));
	if (targetPaths.length === 0) return [];

	const targetSet = new Set(targetPaths);
	const testFiles = uniqueSorted(
		options.files.map((file) => file.path).filter((filePath) => isTestFile(filePath)),
	);
	const bestByTest = new Map<string, TestHint>();

	for (const dep of options.dependencies ?? []) {
		if (!dep.toPath || !targetSet.has(dep.toPath) || !isTestFile(dep.fromPath)) {
			continue;
		}
		bestByTest.set(dep.fromPath, {
			testPath: dep.fromPath,
			targetPath: dep.toPath,
			reason: "direct",
			score: 100,
		});
	}

	for (const testPath of testFiles) {
		for (const targetPath of targetPaths) {
			const hint = relationFromNames(testPath, targetPath);
			if (!hint) continue;
			const current = bestByTest.get(testPath);
			if (!current || hint.score > current.score) {
				bestByTest.set(testPath, hint);
			}
		}
	}

	return Array.from(bestByTest.values())
		.sort((a, b) => {
			const scoreDiff = b.score - a.score;
			if (scoreDiff !== 0) return scoreDiff;
			const testDiff = a.testPath.localeCompare(b.testPath);
			if (testDiff !== 0) return testDiff;
			return a.targetPath.localeCompare(b.targetPath);
		})
		.slice(0, maxTests);
}

export function formatTestHints(hints: TestHint[]): string[] {
	if (hints.length === 0) return [];
	return [
		"Tests:",
		...hints.map((hint) => `T ${hint.testPath} -> ${hint.targetPath} ${hint.reason}`),
	];
}

export function formatSuggestedVerification(hints: TestHint[]): string | undefined {
	const first = hints[0];
	if (!first) return undefined;
	const stem = fileStem(first.testPath);
	if (!stem) return undefined;
	return `Verify: npm test -- ${stem}`;
}