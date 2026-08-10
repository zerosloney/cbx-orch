# Frontend Development Guidelines

## Scope

This repository has a small, framework-free frontend layer rather than a React or SPA application:

- `src/ui.ts` owns the HTTP server, JSON/artifact routes, SSE stream, and the TUI entry point. It serves read projections **and** write operations (approve/cancel/retry/continue, queue pause/resume) via POST endpoints.
- `src/tui/` owns the terminal screen, keyboard lifecycle, status bar, table, detail pane, and ANSI theme.
- `ui/` contains the browser assets served as-is: `index.html`, `app.js`, and `style.css`.
- `src/formatting.ts` owns interactive CLI table/detail rendering used by `src/cli.ts`.
- `tests/interfaces.test.ts`, `tests/ui.test.ts`, and `tests/formatting.test.ts` cover the UI boundaries; `tests/helpers.ts` provides shared fake-agent setup for broader orchestration tests.

## Guides

| Guide | Use it for |
| --- | --- |
| [Directory Structure](./directory-structure.md) | Choosing the correct source, asset, or test location |
| [Component Guidelines](./component-guidelines.md) | TUI renderers and browser DOM rendering |
| [Hook Guidelines](./hook-guidelines.md) | Polling, SSE, keyboard listeners, and cleanup |
| [State Management](./state-management.md) | SQLite, queue, event log, and local view state |
| [Quality Guidelines](./quality-guidelines.md) | Tests, auth boundaries, errors, and verification commands |
| [Type Safety](./type-safety.md) | TypeScript contracts and untyped JSON boundaries |

## Pre-Development Checklist

Before changing a frontend-facing behavior:

1. Trace the data path from persisted state or event log through `src/ui.ts` to `ui/app.js` or a TUI renderer.
2. Search for the same status, artifact name, route, or payload field in `src/`, `ui/`, and `tests/` before adding a second contract.
3. Keep browser assets valid independently of TypeScript; run `node --check ui/app.js` after editing the external script.
4. Preserve the loopback-only server binding and the token auth model: browser uses the `cbx_token` HttpOnly cookie (SameSite=Strict), curl/API clients use `Authorization: Bearer`, SSE keeps query-token compatibility.
5. Write operations (POST) must go through the same auth gate as reads; SameSite=Strict cookie blocks cross-site carrying, so loopback + HttpOnly is sufficient for write safety.
6. Add a focused `node:test` regression for changed behavior, then run the repository checks listed in [Quality Guidelines](./quality-guidelines.md).

## Quality Check

At minimum, run:

```text
npm run lint
npm run format:check
npm test
node --check ui/app.js
git diff --check
```

For route or lifecycle changes, include the relevant focused test file (`tests/interfaces.test.ts` or `tests/ui.test.ts`) in the verification report.
