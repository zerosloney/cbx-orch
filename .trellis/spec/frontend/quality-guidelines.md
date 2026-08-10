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
- For write operations, drive the real POST route end-to-end: cancel → retry → continue, queue pause → resume, and assert both the success path and the auth-required path (401 without credential, 200 with Bearer/cookie).
- When a UI write rejects invalid input (e.g. `extra_rounds` out of range), assert the client-error status (400), not a generic 500.

## Boundaries And Security

- `createWebUiServer` binds only to loopback addresses. Keep that guard when changing host handling.
- With a token configured, `/api/*` requires a valid credential. Three accepted forms, in order:
  1. `cbx_token` **HttpOnly cookie** (`SameSite=Strict; Path=/`) — the browser path. Set on `GET /`; JS/XSS cannot read it and it never appears in the URL query string.
  2. `Authorization: Bearer <token>` header — curl/API clients.
  3. Query token `?token=<token>` — **only** for `/events`, kept for legacy `EventSource` clients that cannot set headers.
  Static UI shell assets are immutable and public so the browser can load them.
- Write operations (POST: approve/cancel/retry/continue, queue pause/resume) go through the same `isAuthorized` gate as reads. The token is never embedded in HTML or JS; do not reintroduce `window.CBX_TOKEN` injection.
- Validate job IDs, workspace paths, test commands, permission modes, and task contracts at the boundary (`src/validation.ts`).
- Escape browser data before `innerHTML`; artifacts and event content are untrusted display data even though the server is local.
- Browser `fetch` must use `credentials: "same-origin"` (cookie auth); `EventSource` uses `withCredentials: true`.

## Error Handling

Use stable `CbxError` codes for errors consumed by routes or callers. Catch only at a defined boundary and return the existing JSON/text contract. Best-effort event delivery must not mask a durable state write; when a fallback is swallowed, record an event or diagnostic as the surrounding module does.

## Avoid

- Do not add a frontend dependency or framework without changing the package architecture and its test/build gates.
- Do not rely on a passing TypeScript build to validate `ui/app.js`.
- Do not add tests that merely mirror implementation branches without proving behavior.
- Do not weaken authentication or path validation to make a UI test pass.
