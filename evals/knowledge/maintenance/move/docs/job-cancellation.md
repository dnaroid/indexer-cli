# Job cancellation contract

## Type

As-Is

## Lifecycle

Active

## Behavior

Cancelling a job is idempotent. A cancelled job is terminal and cannot resume.

## Related files

- `src/jobs.ts`
- `tests/jobs.test.ts`
