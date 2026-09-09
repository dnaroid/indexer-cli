# Questions for inactive sessions

## Type

As-is

## Lifecycle

Active

## Behavior

A pending interactive question belongs to its originating session. If that
session is not the selected tab, the question remains queued and the tab shows a
pending indicator. Selecting the session reveals the pending question without
moving it to another session.

## Related files

- `src/questions/session-question.ts`
- `tests/questions/inactive-tab.test.ts`
