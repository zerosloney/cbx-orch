# Design

## Boundaries

- `ui/`: repair the extracted browser assets and add small testable helpers only where needed.
- `src/ui.ts`: adjust static-route authorization without changing API/SSE authorization.
- `src/tui/`: make polling configuration observable and refresh behavior immediate.
- Package and plugin manifests: synchronize release metadata and Node compatibility.
- `tests/`: extend existing interface/formatting coverage instead of introducing a new test framework.

## Approach

1. Treat `/`, `/style.css`, and `/app.js` as the public UI shell. Continue requiring the configured token for `/api/*`; continue accepting the query token only for `/events`.
2. Remove the stale closing template fragment from `ui/app.js` and normalize display strings so the browser renders text rather than escape sequences.
3. Mark terminal rows in rendered markup so the one-second elapsed updater skips them.
4. Use `intervalMs` for the TUI data poll. Route the refresh key through the existing asynchronous `fetchData` function.
5. Replace `chalk@6` with a compatible release that supports Node 20, regenerate the lockfile, and update every version manifest to 0.11.0.
6. Add regression assertions for JavaScript parsing, authenticated static assets, terminal elapsed behavior where practical, TUI interval behavior, and release version consistency.

## Compatibility And Safety

- Static CSS and JavaScript contain no workspace data or token. The HTML shell continues to inject the configured token for same-origin authenticated fetches.
- API and SSE authorization tests must remain green.
- No schema, persisted state, or command output contract changes are intended.
