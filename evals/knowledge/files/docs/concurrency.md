# Session concurrency and callback ownership

## Type

As-is

## Lifecycle

Active

## Behavior

Asynchronous callbacks belong to the session/tab that created the operation.
A late callback must update its originating session instead of whichever tab is
currently active. Session identity is captured before async work starts and is
used again when results are applied.

## Related files

- `src/sessions/concurrency.ts`
- `tests/sessions/concurrency.test.ts`
