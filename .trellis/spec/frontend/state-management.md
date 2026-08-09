# State Management

## Durable State Is Server-Owned

The authoritative job and queue state is persisted through `src/storage.ts` in `<workspace>/.cbx/state.sqlite`:

- `jobs` stores serialized `JobState` records.
- `queue_state` stores the queue blob.
- `service_leases`, delivery tables, and `metadata` support coordination and event sequencing.
- SQLite uses WAL mode, busy timeout, migrations, and transactions.

`src/state.ts` owns state transitions. `writeState` loads the current state, applies a narrow update, writes the durable record, mirrors `state.json` for artifacts/compatibility, and publishes `job.state_changed`. State and queue transitions that must be atomic use the queue lock and paired storage functions such as `savePersistedStateAndFinishQueue`.

## Events And Projections

`events.ndjson` is an append-only event/artifact stream. `src/observability.ts` assigns the cross-process sequence in SQLite and appends redacted events; `src/ui.ts` replays/tails them for SSE. A renderer may project events for display, but must not invent a second cursor or treat the browser copy as authoritative.

Use `listJobs`, `loadState`, `listQueue`, and the HTTP read routes as projections of durable state. Do not update SQLite from a browser or TUI component.

## View State

View-only state is local to its owner:

- `src/tui/index.ts` keeps jobs, queue, branch, selection, stopped, and redraw flags in `TuiState`.
- `ui/app.js` keeps `allWorkspaces`, `currentWorkspace`, and `selected` in module scope for the current page.
- `src/formatting.ts` derives strings from an input `JobState`/`QueueFile` and does not retain state.

Keep derived values (elapsed labels, CSS classes, counts) derived from the latest server snapshot. Do not persist them as a second source of truth.

## Configuration Precedence

`src/state.ts:mergeConfig` applies CLI overrides over `.cbx.json` values, then defaults. Preserve this order when adding an option, and normalize structured values through the owning parser before they reach execution.

## Avoid

- Do not edit `.cbx/state.sqlite`, `state.json`, or queue files directly from UI code.
- Do not update state and queue in separate writes when the transition is logically atomic.
- Do not treat `events.ndjson` as a replacement for the authoritative state row.
- Do not let an event delivery, SSE client, or browser refresh failure roll back a durable state transition.
