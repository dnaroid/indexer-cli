# Session refresh contract

## Type

As-Is

## Lifecycle

Active

## Behavior

A failed session token load is retried exactly once. If the retry also fails,
the second error propagates. Session ownership stays with the initiating session.

## Related files

- `src/session.ts`
- `tests/session-refresh.test.ts`
