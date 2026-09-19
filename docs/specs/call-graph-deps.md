# Call-graph dependency contract

## Scope

This specification defines symbol-level behavior for `idx deps <path> --mode calls`.

## Behavior

- The call graph remains a conservative syntactic approximation: an edge is emitted only when its callable name and available receiver context identify a candidate.
- Unqualified calls retain same-file and internal-import candidate resolution.
- For TypeScript `this.method()` calls, the callee must be a method directly owned by the enclosing lexical class. Object-literal methods do not inherit an enclosing class's `this`; same-named methods in other classes or imported files are not candidates.
- An arrow function inherits the enclosing method's lexical `this`. A nested ordinary function does not; its `this.method()` call produces no class-method edge without type resolution.
- TypeScript `ClassName.method()` is resolved only when exactly one candidate class of that name is available in the caller file or its internal imports, and only to that class's static method. Duplicate class names remain unresolved.
- A static receiver identifier must bind to a class declaration or import, not an unresolved local variable or parameter that shadows the class name.
- A local receiver initialized directly with `new ClassName()`, or a parameter annotated with `ClassName`, is resolved to that class's instance method only when the call identifier resolves to that lexical binding and it has not been directly reassigned before the call. Other object receivers remain unresolved rather than being matched by property name alone.

## Evidence

- Implementation: `src/cli/commands/deps.ts`
- CLI regression coverage: `tests/cli/deps-call-graph.test.ts`

## Limits

The command does not perform control-flow or TypeScript type analysis beyond lexical binding identity. It does not resolve aliases, instance variables, inheritance, overloads, dynamic dispatch, or arbitrary object receivers; a directly reassigned local or parameter is also unresolved. Those cases intentionally omit edges rather than risk unrelated same-named call targets.
