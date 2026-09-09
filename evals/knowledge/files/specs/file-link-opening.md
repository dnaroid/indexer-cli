# Opening local file links

## Type

As-is

## Lifecycle

Active

## Behavior

Markdown links that resolve to project-local files open inside the desktop
application using the file-opening bridge. External URLs still use the external
browser path and path traversal outside the project is rejected.

## Related files

- `desktop/src/links/open-file.ts`
- `desktop/tests/file-link-opening.test.ts`
