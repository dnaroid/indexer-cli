# Session recovery after context compaction

## Type

As-is

## Lifecycle

Active

## Behavior

When context pruning or compaction replaces older prompt history with a compact
representation, session recovery reconstructs the user-visible conversation
from the durable raw history. Compaction is not destructive decompression: the
recovery path replays canonical raw turns and preserves their original order.

## Related files

- `src/session/recovery.ts`
- `tests/session/recovery.test.ts`
