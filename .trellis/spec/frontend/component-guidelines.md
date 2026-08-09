# Component Guidelines

## No Framework Components

The project does not use React, Vue, JSX, or a component runtime. "Components" are either pure TUI render functions or small browser DOM functions.

### TUI Renderers

TUI components accept typed data and return strings. They do not read SQLite, mutate global state, or install listeners.

```ts
// src/tui/components/job-table.ts
export function renderJobTable(
  rows: TableRow[],
  selectedIndex: number,
  maxRows: number,
  cols: number,
): string { /* format only */ }
```

Follow the local split:

- `buildRows` converts `JobState[]` to a display model.
- `renderJobTable` handles widths, truncation, selection, and ANSI styling.
- `renderDetailPane` renders one optional job (`src/tui/components/detail-pane.ts`).
- `renderStatusBar` renders queue and branch summary (`src/tui/components/status-bar.ts`).

### Browser Rendering

`ui/app.js` owns browser view functions and uses stable IDs from `ui/index.html`. Keep data fetching, view-model calculation, and DOM updates recognizable as separate steps, as in `loadWorkspaces`, `renderWorkspaces`, `refresh`, and `loadTab`.

- Use `textContent` for plain text.
- If a string must be inserted through `innerHTML`, pass dynamic text through the local `esc` helper first.
- Use `data-*` attributes for selection state and event delegation (`data-id`, `data-terminal`).
- Keep status styling as CSS classes derived from the known status contract; do not create a new renderer for every status.

## Server Helpers

Export pure or filesystem-scoped helpers from `src/ui.ts` when they can be tested without a running server. Existing examples are `parseCursors`, `buildTimeline`, `readExecutorStatus`, and `readAgentLogIncremental`. Route handlers should compose these helpers and serialize their result with the local `json`/`text` functions.

## Avoid

- Do not access `process`, SQLite, or filesystem state from a TUI component.
- Do not duplicate job status colors, terminal status lists, or artifact names in multiple renderers without checking existing definitions.
- Do not concatenate unescaped job IDs, workspace paths, artifact contents, or event fields into browser HTML.
- Do not make a renderer responsible for polling, keyboard input, server auth, or cleanup.
