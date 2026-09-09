# Desktop window state restoration

## Type

As-is

## Lifecycle

Active

## Behavior

Desktop windows remember their previous position and size. On restore the saved
bounds are validated against the currently attached displays; an offscreen or
no-longer-visible position is clamped or recentered onto a usable monitor.

## Related files

- `desktop/src/window-state.ts`
- `desktop/tests/window-state.test.ts`
