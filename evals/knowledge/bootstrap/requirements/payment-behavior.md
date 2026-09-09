# Payment behavior requirements

## Type

As-Is

## Lifecycle

Active

## Behavior

Payment submission is idempotent by request key. Duplicate submissions return
the original payment result without charging twice.

## Related files

- `src/payments.ts`
- `tests/payments.test.ts`
