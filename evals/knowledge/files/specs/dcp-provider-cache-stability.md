# DCP provider cache stability

## Type

As-is

## Lifecycle

Active

## Behavior

Dynamic context pruning must keep provider-visible tool results deterministic
until the provider has observed them. An older tool result must not disappear or
change shape before the provider request that first contains it, because doing
so invalidates prompt-cache reuse and changes provider-visible history.

## Related files

- `src/dcp/provider-cache.ts`
- `tests/dcp/provider-cache.test.ts`
