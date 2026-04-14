# indexer-cli

`indexer-cli` exists to minimize token usage during model onboarding: help an agent quickly assemble useful context for solving work in a target project without wasting tokens on broad, repetitive repository discovery.

## Working with the CLI

- Build first before testing CLI changes.
- Test changed CLI behavior through `tsx bin/indexer-cli.js`.

## Change discipline

- When adding or changing functionality, keep `README.md` in sync.
- When adding or changing functionality, update tests as needed: unit tests and/or CLI tests.
