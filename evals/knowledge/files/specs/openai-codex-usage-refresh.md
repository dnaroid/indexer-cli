# OpenAI Codex usage refresh

## Type

As-is

## Lifecycle

Active

## Behavior

The model usage status refreshes OpenAI Codex account limits through one
deduplicated in-flight request. Repeated refresh requests reuse the same
operation until it completes, then update the latest usage snapshot.

## Related files

- `src/app/model/model-usage-status.ts`
- `tests/model/model-usage-status.test.ts`
