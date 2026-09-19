# Runtime support contract

## Scope

This specification defines the supported Node.js runtime lines for `indexer-cli`,
the CI evidence required for those runtimes, and the source-checkout global
installation behavior on macOS.

## Supported Node.js versions

The public package contract is the `package.json` engine range:

```json
"node": "^22.19.0 || ^24.0.0 || ^26.0.0"
```

Therefore `indexer-cli` supports:

- Node.js 22 starting at 22.19.0 and remaining within the 22.x line;
- Node.js 24.x;
- Node.js 26.x.

Node.js 23.x, 25.x, Node.js 22 before 22.19.0, and older major lines are
outside the supported runtime contract. Dependency upgrades must not silently
raise or broaden this range; changing supported runtime lines is an explicit
contract change.

## CI contract

`.github/workflows/publish.yml` must build and run the unit suite on Node.js
22.19.0, Node.js 24, and Node.js 26. Packaging smoke tests and npm publishing
use Node.js 24. This makes the lower supported boundary, the preferred release
runtime, and the newest supported even-numbered runtime executable CI evidence
rather than documentation-only claims.

## Global installation from a source checkout

`npm run install:global` is a developer convenience for installing the current
source checkout globally on macOS. `scripts/install-global.sh` must:

- require Homebrew `node@24` and print `brew install node@24` when it is absent;
- run the build and global npm installation with that Homebrew Node 24 toolchain;
- pin npm's global prefix to the Homebrew prefix even when the command was
  launched from mise, nvm, asdf, or another Node version manager;
- replace only launchers that are already owned by `indexer-cli`, refusing to
  overwrite an unrelated `idx` or `indexer-cli` executable;
- write `idx` and `indexer-cli` wrappers with an absolute Homebrew Node 24 path,
  so runtime execution does not depend on shell Node resolution or version-manager
  reshimming.

This Homebrew requirement applies only to the source-checkout convenience command.
The published npm package remains installable with any Node runtime allowed by the
public engine range.

## Evidence

- Runtime declaration: `package.json`
- Lockfile package metadata: `package-lock.json`
- CI matrix and publish runtime: `.github/workflows/publish.yml`
- Source global installer: `scripts/install-global.sh`
- User-facing prerequisites/install guidance: `README.md`
- Published package launcher/install coverage: `tests/unit/bin/package-install.test.ts`
