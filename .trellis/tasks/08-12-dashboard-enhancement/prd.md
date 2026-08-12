# Dashboard Kanban Enhancement

## Goal

Enhance the cbx Web UI dashboard so the current state of all tasks is visible "at a glance", inspired by Paperclip's dashboard design.

## Background

The current dashboard (`ui/index.html` + `ui/app.js` + `ui/style.css`) shows 6 summary cards (总任务 / 运行中 / 失败 / 队列 / 最后活动 / 健康) plus a flat job table. Data is available from existing endpoints (`/api/jobs`, `/api/queue`) with no backend changes needed.

## Requirements

1. **Status distribution bar** — a horizontal stacked bar at the top of the dashboard, segmented by job status:
   - `done` (green), `running` (yellow), `queued` (blue), `failed` + `needs_fix` + `review_failed` (red), `awaiting_approval` (orange), `cancelled` (gray)
   - Hover shows the count per segment (title attribute is sufficient)
   - Absent entirely when there are no jobs
2. **Granular status cards** — expand from 6 to 9 cards:
   - Keep: 总任务, 运行中/并发, 队列, 最后活动, 健康
   - Split 失败 into: 失败 (`failed`), 返工 (`needs_fix` + `review_failed`)
   - Add: 待审批 (`awaiting_approval`), 完成 (`done`)
3. **Click-to-filter** — clicking a status card filters the job table to jobs with that status; clicking again clears the filter. Show a visual indicator of the active filter (card highlight + a clear button).
   - Card mapping: 总任务 → no filter; 运行中 → `running`; 失败 → `failed`; 返工 → `needs_fix` + `review_failed`; 待审批 → `awaiting_approval`; 完成 → `done`; 队列 → queued entries count (not a filter, since queue is from `/api/queue`); 最后活动 / 健康 → not filterable.
4. **Estimates displayed** — no backend changes; the job table already shows status/phase/attempt/review/elapsed
5. Pure frontend: no changes to `src/ui.ts` or any TypeScript; all changes in `ui/` directory

## Non-Goals

- No backend/API changes
- No per-job token/cost display (requires backend work)
- No multi-workspace aggregation changes
- No charting library — hand-rolled HTML/CSS only

## Acceptance Criteria

1. Distribution bar renders with correct segment proportions and colors for a mixed job set
2. Bar is hidden when no jobs exist
3. Nine cards render with correct counts; 失败 and 返工 are separate cards
4. Clicking 运行中/失败/返工/待审批/完成 filters the table; clicking again or clicking 总任务 clears the filter
5. Active filter is visible (card highlighted + filter indicator)
6. `npm run check` passes (lint + format + existing tests stay green)
7. Browser smoke test: dashboard renders with a real job set, filter works