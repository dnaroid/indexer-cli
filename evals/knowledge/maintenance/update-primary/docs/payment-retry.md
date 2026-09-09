# Payment retry contract

## Type

As-is

## Lifecycle

Active

## Behavior

All retry attempts for one payment reuse the same idempotency key.

## Relations

- `src/payments.ts`
- `tests/payments.test.ts`
