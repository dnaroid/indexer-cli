# Runtime support contract

## Scope

This specification defines the supported Node.js runtime lines for `indexer-cli`,
the CI evidence required for those runtimes, and the source-checkout global
installation behavior on macOS.

## Supported Node.js versions

The public package contract is the `package.json` engine range:

```json
"node": ">=22.19.0 <27"
```

Therefore `indexer-cli` accepts Node.js 22.19.0 through Node.js 26.x. The CI
compatibility matrix explicitly exercises the lower supported boundary plus the
primary even-numbered runtime lines:

- Node.js 22.19.0;
- Node.js 24.x;
- Node.js 26.x.

Node.js before 22.19.0 and Node.js 27+ are outside the public package range.
Dependency upgrades must not silently raise or broaden this range; changing it
is an explicit contract change.

## Source development runtime

The repository does not pin a separate development Node major. Local commands
use the active `node` and `npm` from `PATH`, subject to the same public engine
range as the package. The repo contains native addons such as `better-sqlite3`
and tree-sitter bindings, so intentionally changing Node major requires one
clean local dependency rebuild (`rm -rf node_modules && npm ci`) before using
the checkout under the new runtime.

## CI contract

`.github/workflows/publish.yml` must build and run the unit suite on Node.js
22.19.0, Node.js 24, and Node.js 26. Packaging smoke tests and npm publishing use
one supported CI runtime independently of the developer's local runtime. This
makes the supported range executable CI evidence without pinning local tooling.

## Global installation from a source checkout

`npm run install:global` is a developer convenience for installing the current
source checkout globally on macOS. `scripts/install-global.sh` must:

- prefer a conventional system Node/npm pair when available (for example
  Homebrew's stable `/opt/homebrew/bin` paths), otherwise fall back to the
  caller's `PATH`, and reject only runtimes outside the public engine range;
- run the build and global npm installation with the selected Node/npm pair;
- use the selected npm's own global prefix rather than a version-manager prefix;
- replace only launchers that are already owned by `indexer-cli`, refusing to
  overwrite an unrelated `idx` or `indexer-cli` executable;
- write `idx` and `indexer-cli` wrappers bound to the selected system Node
  executable so later PATH/version-manager changes cannot load native addons
  under a different Node ABI. The path must not encode a specific Node version.

The published npm package and the source-checkout convenience command therefore
share the same Node range and do not require a particular version manager.

`idx setup` follows the same preference: when a conventional system npm/global
installation is available, it is preferred over a version-manager-specific npm
prefix. The repair wrapper under `~/.local/bin/idx` checks system global
locations before consulting the current npm prefix, so changing nvm/mise/asdf
selection cannot silently route `idx` to a stale package installed under another
Node tree.

The npm package postinstall and source global install must ensure the commented
global ask configuration template exists; the source installer also invokes the
shared bootstrap explicitly so the resolved path is visible when npm suppresses
lifecycle output or scripts. With npm lifecycle scripts disabled, users must run
`idx doctor` to create the template. Doctor also
ensures it on every invocation. Creation failure is warning-only and must not
break installation or doctor.

## Evidence

- Runtime declaration: `package.json`
- Lockfile package metadata: `package-lock.json`
- CI matrix and publish runtime: `.github/workflows/publish.yml`
- Source global installer: `scripts/install-global.sh`
- Setup/global wrapper selection: `src/core/idx-binary.ts`, `src/cli/commands/setup.ts`
- User-facing prerequisites/install guidance: `README.md`
- Published package launcher/install coverage: `tests/unit/bin/package-install.test.ts`
- Setup/global wrapper coverage: `tests/unit/core/idx-binary.test.ts`, `tests/unit/cli/setup.test.ts`
