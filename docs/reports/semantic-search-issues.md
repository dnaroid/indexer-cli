# Semantic Search (`indexer-cli search`) — Known Issues

**Date**: 2026-04-12
**Source**: Evaluation against smart-learning-platform-server (NestJS, 322 TS files, ~26.8K lines)
**Test coverage**: 20 queries across 4 categories

---

## Issue 1: No "nothing found" threshold — baseline noise at ~0.68

### Problem

`indexer-cli search` always returns results, regardless of whether the queried concept exists in the codebase. There is no minimum score threshold below which results are suppressed.

### Evidence

**Query**: `cyclic dependency`

**Expected**: No results — the codebase contains no cyclic-dependency detection or handling code.

**Actual**:

```
src/models/sockets/adapters/redis-adapter.ts:8-26 (score: 0.68, function: RedisIoAdapter)
```

Redis adapter has no relation to cyclic dependencies. The result is pure vector-proximity noise.

### Impact

- Any query returns at least 1-3 results with score ~0.68, even for nonexistent concepts.
- This makes it impossible to distinguish "weak match" from "no match" without manual inspection.
- Agents using semantic search cannot programmatically determine if a concept exists in the codebase.

### Proposed fix

1. **Introduce `--min-score` as a default filter**. Suggested default: `0.70`. Results below this threshold are suppressed unless the user explicitly passes `--min-score 0`.
2. **Or: emit a warning** when all returned results fall below a confidence threshold. For example:

   ```
   ⚠️ All results scored below 0.70 — query may not match any code in the codebase.
   ```

3. **Or: include a "best score" indicator** in the output header so the consumer can decide:

   ```
   Best score: 0.68 (low confidence)
   ```

### Score distribution from testing

| Score range | Meaning                        | Frequency in tests |
| ----------- | ------------------------------ | ------------------ |
| 0.80–0.85   | Exact match, high confidence   | ~30% of queries    |
| 0.70–0.79   | Relevant, correct module       | ~45% of queries    |
| 0.68–0.69   | Noise baseline, often wrong    | ~25% of queries    |

The ~0.68 band is where false positives concentrate. A threshold at 0.70 would eliminate most noise while preserving all correct results.

---

## Issue 2: `function` field shows internal variable names, not actual function names

### Problem

The `function` metadata in search results does not reflect the name of the enclosing function/method. Instead, it shows a variable name, parameter, or identifier found somewhere inside the matched code chunk — often the first prominent identifier after the function declaration.

### Evidence

| Query                        | Result file:lines                       | Expected `function`                              | Actual `function` | Score |
| ---------------------------- | --------------------------------------- | ------------------------------------------------ | ----------------- | ----- |
| `password reset`             | `auth.service.ts:148-208`               | `resetPassword`                                  | `user`            | 0.72  |
| `magic link login`           | `auth.controller.ts:176-193`            | `federateCallback`                               | `host`            | 0.75  |
| `magic link login`           | `auth.service.ts:269-291`               | `sendMagicLink`                                  | `hash`            | 0.73  |
| `magic link login`           | `emails.ts:11-49`                       | `magicLink`                                      | `config`          | 0.71  |
| `billing subscription cancel` | `billing.service.ts:404-471`            | `abortSubscription`                              | `updatedUser`     | 0.85  |
| `billing subscription cancel` | `stripe.service.ts:157-220`             | `abortCurrentAndNextSubscription`                | `schedules`       | 0.84  |
| `billing subscription cancel` | `stripe.service.ts:78-162`              | `getCustomerSubscriptionsAndSchedules` / `abortSubscription` | `subs`      | 0.83  |
| `email template`             | `custom-email.lambda.js:22-70`          | `handler`                                        | `template`        | 0.83  |
| `stripe webhook`             | `billing.service.ts:299-360`            | `handleStripeWebhook`                            | `user`            | 0.80  |

**Pattern**: The `function` value is always a variable or parameter name from inside the function body, never the declared function name.

### Detailed repro steps

**Test project**: `/Volumes/128GBSSD/Projects/smart-learning-platform-server`

#### Case 1: `password reset` → `function: user`

```bash
cd /Volumes/128GBSSD/Projects/smart-learning-platform-server
npx indexer-cli search "password reset"
```

Output:
```
src/models/auth/auth.service.ts:148-208 (score: 0.72, function: user)
```

Actual code at `auth.service.ts:148-208` (read the file):
```typescript
async resetPassword({ email }: RegisterDto) {   // ← declared name: resetPassword
    const user = await this.usersRepository.findOne({ where: { email } });  // ← "user" picked up
    if (user) {
      user.confirmation_code = this.generateConfirmationCode();
      await this.usersRepository.save(user);
      ...
```

The `function` field shows `user` — a local variable from line ~150, not the method name `resetPassword` on line 148.

#### Case 2: `magic link login` → `function: host`

```bash
npx indexer-cli search "magic link login"
```

Output:
```
src/models/auth/auth.controller.ts:176-193 (score: 0.75, function: host)
```

Actual code at `auth.controller.ts:176-193`:
```typescript
@Get("link")
async federateCallback(@Query() ...) {          // ← declared name: federateCallback
    const host = req.get("host");                // ← "host" picked up
    return res.redirect(`${host}/en/federate-callback?token=...`);
```

The `function` field shows `host` — an Express request property, not the method name `federateCallback`.

#### Case 3: `billing subscription cancel` → `function: schedules`

```bash
npx indexer-cli search "billing subscription cancel"
```

Output:
```
src/models/stripe/stripe.service.ts:157-220 (score: 0.84, function: schedules)
```

Actual code at `stripe.service.ts:157-220`:
```typescript
async abortCurrentAndNextSubscription(customer: string) {  // ← declared name
    const { subscriptions, schedules } = await ...;         // ← "schedules" picked up
```

The `function` field shows `schedules` — a destructured variable from the return value.

#### Case 4: `magic link login` → `function: config`

```bash
npx indexer-cli search "magic link login"
```

Output:
```
src/models/aws/emails.ts:11-49 (score: 0.71, function: config)
```

Actual code at `emails.ts:11-49`:
```typescript
const config = () => {                   // ← this is a module-level const, NOT the exported function
    return configService.getAppConfig();
};

export function magicLink(to: string, hash: string) {  // ← this is the actual exported function
    const subj = `Your magic link for ${config().siteTitle} sign in`;
```

The `function` field shows `config` — a private helper, not the exported `magicLink` function that the chunk is actually about.

### Impact

- **Readability**: The `function` field is unreliable for identifying which function was matched. Consumers must read the actual file to determine the function name.
- **Agent efficiency**: Subagents relying on `function` metadata to decide whether to read a file will get misleading signals.
- **Not blocking**: Search still returns correct file paths and line ranges. The issue is metadata quality, not result quality.

### Root cause hypothesis

The `function` value is likely extracted as the first prominent identifier found in the chunk after function declaration, or from an imperfect AST traversal. The pattern across all evidence:

1. **Destructured variables** are picked up: `{ subscriptions, schedules }` → `schedules`
2. **Local variables** are picked up: `const user = await ...` → `user`
3. **Request properties** are picked up: `req.get("host")` → `host`
4. **Module-level helpers** override exported functions: `const config = () => ...` over `export function magicLink`

The extraction logic appears to grab a "representative identifier" from inside the chunk rather than resolving the enclosing function/method declaration from the AST.

### Proposed fix

1. **Use the enclosing function/method name** from the AST, not an internal identifier. Walk up the AST tree from the matched chunk range to find the nearest `FunctionDeclaration`, `MethodDefinition`, or `ArrowFunctionExpression` with a name.
2. **Or: label the field more accurately** as `context` instead of `function`, since it doesn't consistently represent a function name.
3. **Or: include both** — `function: resetPassword, variable: user` — to preserve the current behavior while adding the correct name.

---

## Summary

| Issue | Severity | User impact | Fix complexity |
| --- | --- | --- | --- |
| No "nothing found" threshold | **Medium** | False positives on every query; agents can't detect absent concepts | Low — add `--min-score` default |
| `function` field unreliable | **Low** | Misleading metadata; doesn't block search functionality | Medium — requires AST-level fix |

Both issues are non-blocking but affect reliability when semantic search is used programmatically (by agents or CI tools).
