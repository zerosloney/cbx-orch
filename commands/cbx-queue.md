---
description: Inspect or control the cbx task queue (pause / resume).
argument-hint: "[pause|resume]"
---

Manage the cbx queue for the current workspace.

- With no argument or `status`: call `mcp__cbx__cbx_queue` and show `paused`, `maxConcurrent`, running count, and queued count.
- With `pause`: call `mcp__cbx__cbx_queue_pause` to stop new workers from starting (in-flight jobs continue).
- With `resume`: call `mcp__cbx__cbx_queue_resume` to restart dispatch.

To retry a specific failed job, use `mcp__cbx__cbx_retry` with its `job_id`.
