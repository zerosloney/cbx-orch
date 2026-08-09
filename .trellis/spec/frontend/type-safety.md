# Type Safety

## TypeScript Baseline

`tsconfig.json` uses `strict: true`, `target: ES2022`, `module`/`moduleResolution: NodeNext`, and `forceConsistentCasingInFileNames`. TypeScript source is ESM and relative imports include the emitted `.js` suffix, for example `import { loadState } from "./state.js"`.

Use the shared domain contracts in `src/types.ts` (`JobStatus`, `JobState`, `JobContext`, `StageReport`) and re-export public contracts through `src/core.ts`. Keep queue contracts in `src/queue.ts`, executor contracts in `src/executor.ts`, and task contract validation in `src/validation.ts`.

## Unknown JSON Boundaries

JSON, SQLite blobs, plugin modules, event lines, and HTTP payloads are untrusted boundaries. Parse to `unknown` or a narrow record, validate shape, reject unknown fields where the contract is strict, then return a typed value.

```ts
// src/validation.ts
export function normalizeTaskContract(
  value?: TaskContract,
): TaskContract | undefined {
  // validates object shape, fields, arrays, stage dependencies, and cycles
}
```

Other local examples are `parseNextAction` in `src/adaptive-manager.ts`, `parsePendingCompletion` in `src/evidence.ts`, and `validateManifest` in `src/executor.ts`. Preserve their pattern of checking type, allowed keys, required fields, and cross-field constraints before execution.

## Narrowing And Casts

- Prefer type guards, explicit predicates, and normalized return types over `any`.
- `Record<string, unknown>` is appropriate for extensible state fields and event detail; narrow a field immediately before use.
- A type assertion is acceptable only after a runtime boundary check or when reading a typed SQLite row whose query shape is local and obvious. Do not use `as any` to bypass a failed contract.
- Keep optional values explicit (`reviewExecutor?: string`, `testExitCode: number | null`) and handle `null`/missing values at display boundaries.

## Browser And Persistence Contracts

`ui/app.js` is plain JavaScript and is not covered by TypeScript's compiler. Its API shapes are established by `src/ui.ts` and protected by `tests/interfaces.test.ts`; update the server response, browser consumer, and test together. Keep `esc` and DOM text insertion at the browser boundary.

SQLite JSON blobs and NDJSON events are serialized contracts. Add migrations or compatibility handling in `src/storage.ts`/the owning parser when a field changes; do not silently reinterpret a persisted field in a renderer.

## Avoid

- Do not duplicate a JSON payload shape as unrelated local casts in multiple consumers.
- Do not import from `dist/` in source or tests; compile source through the package build.
- Do not use CommonJS imports, extensionless relative ESM imports, or unchecked `JSON.parse` results in execution paths.
- Do not broaden an enum/status union with an arbitrary string without deciding how persistence, queue transitions, CLI output, and UI colors handle the new value.
