# Background agent cancellation

## Type

As-is

## Lifecycle

Active

## Behavior

Stopping a background agent cancels the currently running child operation once,
propagates cancellation to its task scope, and prevents late completion from
being applied as a successful result. Repeated stop requests are idempotent.

## Related files

- `src/agents/background-cancel.ts`
- `tests/agents/background-cancel.test.ts`
