# Quality Guidelines

## Required Checks

The package uses strict TypeScript and Node's built-in test runner:

```text
npm run lint          # tsc --noEmit -p tsconfig.json
npm run format:check  # repository Prettier gate
npm test              # build, then node --test dist/tests/*.test.js
npm run coverage      # build and threshold check
```

CI runs lint, formatting, audit, tests, coverage, and SBOM generation on Node 20, 22, and 24 (`.github/workflows/ci.yml`). When changing `ui/app.js`, also run `node --check ui/app.js`; the browser asset is not compiled by `tsconfig.json`.

## Test Style

Use `node:test` and `node:assert/strict`, with one behavior-focused test name per contract. Use `mkdtemp` for isolated workspaces and the shared fake executor in `tests/helpers.ts` for orchestration flows. Use real HTTP servers for route/auth tests (`tests/interfaces.test.ts`) and small seams for TUI timers/keyboard actions (`tests/ui.test.ts`).

Prefer observable behavior over source-text assertions:

- Fetch `/`, static assets, API routes, and `/events` to verify HTTP status and auth boundaries.
- Execute browser JavaScript with `node:vm` syntax/runtime stubs when a DOM behavior needs a regression.
- Assert terminal elapsed values, listener counts, cleanup, and persisted state, not just the presence of a string in source.

## Boundaries And Security

- `createWebUiServer` binds only to loopback addresses. Keep that guard when changing host handling.
- With a token configured, `/api/*` requires `Authorization: Bearer ...`; query tokens are accepted only for `/events` because native `EventSource` cannot set headers. Static UI shell assets are immutable and public so the browser can load them.
- Validate job IDs, workspace paths, test commands, permission modes, and task contracts at the boundary (`src/validation.ts`).
- Escape browser data before `innerHTML`; artifacts and event content are untrusted display data even though the server is local.

## Error Handling

Use stable `CbxError` codes for errors consumed by routes or callers. Catch only at a defined boundary and return the existing JSON/text contract. Best-effort event delivery must not mask a durable state write; when a fallback is swallowed, record an event or diagnostic as the surrounding module does.

## Avoid

- Do not add a frontend dependency or framework without changing the package architecture and its test/build gates.
- Do not rely on a passing TypeScript build to validate `ui/app.js`.
- Do not add tests that merely mirror implementation branches without proving behavior.
- Do not weaken authentication or path validation to make a UI test pass.
