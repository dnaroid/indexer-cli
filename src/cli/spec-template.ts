import { writeFile } from "node:fs/promises";
import path from "node:path";

export const SPEC_TEMPLATE = `---
kind: spec
status: proposed
---

# Feature or subsystem

## Behavior

Describe the intended behavior, guarantees, and principal user scenarios.
Set status to active when this describes the current supported contract.

## Constraints and failure cases

Describe important limits, errors, and interactions with other subsystems.

## Implementation

Paths below are relative to the project root. Replace these examples with real
paths. Optional ::Symbol suffixes refine navigation; file changes remain a
conservative audit signal, not proof that a particular symbol changed.

- \`src/feature.ts\`
- \`src/feature.ts::Feature\`

## Tests

- \`tests/feature.test.ts\`

## Verification

Describe relevant checks and observable expected outcomes. A task-end audit
identifies related changes; the working agent decides whether the prose needs
updating. No review receipt or acknowledgment is required.
`;

export async function installSpecTemplate(dataDir: string): Promise<string> {
	const target = path.join(dataDir, "spec-template.md");
	try {
		await writeFile(target, SPEC_TEMPLATE, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return target;
}
