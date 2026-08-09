# Directory Structure

## Repository Shape

This is a single ESM TypeScript package. There is no application package split or frontend framework directory.

```text
src/
  cli.ts                 CLI command routing and process entry point
  core.ts                compatibility barrel for domain exports
  *.ts                   focused orchestration, storage, validation, and adapter modules
  ui.ts                  HTTP/SSE server and TUI bootstrap
  formatting.ts          interactive CLI formatting
  tui/                   terminal UI implementation
    components/          pure table, status, and detail renderers
ui/
  index.html              browser shell
  app.js                  browser state, fetches, DOM events, and SSE
  style.css               browser presentation
tests/
  core.*.test.ts          orchestration behavior grouped by concern
  interfaces.test.ts      HTTP, CLI/interface, and integration boundaries
  ui.test.ts              TUI and server helper behavior
  formatting.test.ts      interactive CLI formatting
  helpers.ts              shared fake executors and workspace setup
```

Generated or runtime data does not belong in source directories. Build output is under `dist/`; runtime job state and artifacts live under a target workspace's `.cbx/` directory.

## Placement Rules

- Add a new orchestration behavior to the focused domain module (`src/jobs.ts`, `src/execution.ts`, `src/queue.ts`, etc.) and re-export its public contract through `src/core.ts` when callers need the compatibility API.
- Keep HTTP route dispatch and browser-facing helper logic in `src/ui.ts`. Put browser code in `ui/app.js`; do not rebuild the whole HTML/JS bundle inside a TypeScript template.
- Put TUI rendering in `src/tui/components/` as pure functions. Keep terminal setup, polling, and lifecycle ownership in `src/tui/index.ts`.
- Put shared domain types in `src/types.ts` and validation/normalization contracts in `src/validation.ts` or the owning parser module.
- Put a regression beside the behavior area: HTTP/auth tests in `tests/interfaces.test.ts`, TUI/timeline tests in `tests/ui.test.ts`, and formatter tests in `tests/formatting.test.ts`.

## References

- `src/core.ts` is the public compatibility barrel over focused modules.
- `src/ui.ts` contains `createWebUiServer`, `buildTimeline`, `readExecutorStatus`, and `runTui`.
- `src/tui/index.ts` contains `startTui`, `handleTuiKey`, and `scheduleTuiPoll`.
- `tests/helpers.ts` is the shared fake-agent fixture used by the split core tests.

## Avoid

- Do not create `components/`, `hooks/`, or state-library directories that imply React or another framework not used here.
- Do not put `.cbx` artifacts, `dist/`, or temporary fake workspaces under versioned source or test fixtures.
- Do not bypass `src/core.ts` with ad hoc imports from an old monolithic module; the focused modules are the current implementation.
