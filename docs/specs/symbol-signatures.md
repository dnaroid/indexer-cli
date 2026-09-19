# Symbol signature contract

## Scope

This contract covers the `signature` stored for TypeScript and JavaScript
function and class-method symbols and displayed by `idx explain`.

## Callable signatures

- A callable signature contains the complete declaration before its executable
  body: modifiers, name, type parameters, every parameter/default value, and
  return type are retained.
- The executable body and its opening brace are excluded.
- Multi-line declarations retain their newlines. This makes all parameter and
  return-type information available to `idx explain --signature-only` without
  including implementation lines.
- The boundary is obtained from the TypeScript AST body node, not by splitting
  text at `{`. Object types and object/arrow-function defaults may themselves
  contain braces.
- Body-less declarations (for example overloads) retain their declaration text.

## Existing indexes

Signatures are snapshot metadata, so existing completed snapshots are not
migrated solely for this presentation improvement. For legacy TypeScript/JS
function and method rows whose stored signature is a strict prefix of the live
declaration, or contains that declaration followed by its opening body brace,
`idx explain` derives the body-free declaration from the current
file at display time. Thus an upgrade does not require `idx index` merely to
make `--signature-only` useful. It never writes that repair back to the
snapshot; normal indexing persists it on the next changed-file refresh. If the
live file is absent, unparsable, moved, or no longer matches the indexed symbol
range, explain safely displays the stored legacy value instead. While a stale
snapshot is being used because indexing is locked, this fallback may show the
current declaration rather than that snapshot's historical text.

## Evidence

- Extraction: `src/languages/typescript.ts`
- Regression coverage: `tests/plugins/typescript.test.ts`
- Legacy display regression coverage: `tests/unit/cli/explain-signature.test.ts`
- Display repair: `src/cli/commands/explain.ts`
