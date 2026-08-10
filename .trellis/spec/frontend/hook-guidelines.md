# Hook And Lifecycle Guidelines

There is no custom hook abstraction in this repository. Lifecycle behavior is implemented explicitly with Node timers/listeners in the TUI and browser timers/EventSource in `ui/app.js`.

## TUI Lifecycle

`startTui` owns all resources created during a terminal session:

- `startKeyboardListener` returns a disposer that removes its `keypress` and owned stdin `data` listener and restores raw mode.
- Poll, draw, and stop-check timers are cleared on exit.
- The SIGINT listener is removed after the session.
- `hideCursor` is paired with `showCursor` in cleanup, even when drawing or fetching fails.

Use `try/finally` around a new long-lived TUI resource. Background timers that should not keep the process alive call `.unref()` through the existing pattern in `scheduleTuiPoll`.

```ts
// src/tui/index.ts
const pollTimer = scheduleTuiPoll(
  () => fetchData(workspace, state),
  intervalMs,
);
```

The `r` key should trigger the same `fetchData` path as the poller, not merely redraw stale state. Keep keyboard actions in `handleTuiKey` so they can be tested without a terminal.

Queue operations are also keyboard-driven and go through the same `handleTuiKey` seam:

- `p` — pause queue (`pauseQueue`), `u` — resume queue (`resumeQueue`)
- `x` — cancel the selected job (`cancelJob`); ignored when no job is selected
- Pause/resume toggle the local `queuePaused` flag synchronously for instant status feedback, then invoke the queue operation and re-fetch on settlement.
- `handleTuiKey` takes an optional `queueAction` callback so tests can assert the dispatched action and jobId without a real queue.

```ts
// src/tui/index.ts
handleTuiKey(action, state, () => fetchData(workspace, state), queueAction);
```

## Web UI Lifecycle

The browser page installs one delegated jobs-table listener, two refresh intervals, and one EventSource for the lifetime of the page. Keep those handles explicit and avoid starting duplicate streams when adding a view.

On the server, `startEventTailer` returns a stop function and `createWebUiServer` clears tailers and the heartbeat timer on `server.close`. Preserve this ownership boundary when adding a new tailer or timer.

## Async Rules

- Do not leave a `setInterval`, stdin listener, process signal listener, or EventSource without a matching cleanup path.
- Fire-and-forget callbacks must handle their own errors (`void fetchData(...)` is safe because `fetchData` catches and records its failure policy).
- Use the caller-provided interval; do not hard-code a second polling cadence beside the CLI option.
- Do not use a timer to mutate persisted state; UI timers only refresh a view.

## Process Capture Convention

Two capture helpers exist in `src/process-runner.ts`; choose by event-loop impact:

- `capture` (synchronous `spawnSync`) — for worker-process git calls in `git-ops.ts`. A worker is a single-purpose process, so blocking its event loop has no side effect and keeps the call chain synchronous.
- `captureAsync` (async `spawn`) — for git calls in the **main process**: Web UI `summarizeWorkspace` (the UI server shares one event loop with SSE heartbeats and all clients) and TUI polling (a sync git call would freeze keyboard response).

Do not add a new sync `capture` call to a main-process path (UI server, TUI loop, `serve`). When a short-lived external command must run in the UI process, prefer `captureAsync` and run independent calls with `Promise.all`.
