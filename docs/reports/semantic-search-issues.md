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

The `function` metadata in search results does not reflect the name of the enclosing function/method. Instead, it shows a variable name or parameter found somewhere inside the matched code chunk.

### Evidence

| Query              | Result line                                            | Expected `function`     | Actual `function`     |
| ------------------ | ------------------------------------------------------ | ----------------------- | --------------------- |
| `password reset`   | `auth.service.ts:148-208 (score: 0.72, function: user)`    | `resetPassword`         | `user`                |
| `magic link login` | `auth.controller.ts:176-193 (score: 0.75, function: host)` | `magicLinkLogin`        | `host`                |
| `email template`   | `custom-email.lambda.js:22-70 (score: 0.83, function: template)` | `handler` or similar    | `template`            |
| `stripe webhook`   | `billing.service.ts:299-360 (score: 0.80, function: user)` | `handleStripeWebhook`   | `user`                |

### Impact

- **Readability**: The `function` field is unreliable for identifying which function was matched. Consumers must read the actual file to determine the function name.
- **Agent efficiency**: Subagents relying on `function` metadata to decide whether to read a file will get misleading signals.
- **Not blocking**: Search still returns correct file paths and line ranges. The issue is metadata quality, not result quality.

### Root cause hypothesis

The `function` value is likely extracted as the first identifier found in the chunk, or the closest AST node name, rather than the enclosing function/method declaration. For example:

```typescript
// In auth.service.ts:148-208
async resetPassword(user: User, ...) {  // ← should be "resetPassword"
  const token = user.resetToken;         // ← "user" is picked up instead
```

### Proposed fix

1. **Use the enclosing function/method name** from the AST, not an internal identifier.
2. **Or: label the field more accurately** as `context` instead of `function`, since it doesn't consistently represent a function name.
3. **Or: include both** — `function: resetPassword, variable: user` — to preserve the current behavior while adding the correct name.

---

## Summary

| Issue | Severity | User impact | Fix complexity |
| --- | --- | --- | --- |
| No "nothing found" threshold | **Medium** | False positives on every query; agents can't detect absent concepts | Low — add `--min-score` default |
| `function` field unreliable | **Low** | Misleading metadata; doesn't block search functionality | Medium — requires AST-level fix |

Both issues are non-blocking but affect reliability when semantic search is used programmatically (by agents or CI tools).
