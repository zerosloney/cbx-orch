---
description: Show status, phase, and attempt count of a cbx job.
argument-hint: "[job_id]"
---

Report the current state of cbx job `$ARGUMENTS`.

1. Call `mcp__cbx__cbx_status` with `job_id: "$ARGUMENTS"`.
2. Present `status`, `phase`, `attempt`, and `updatedAt` to the user in a compact form.
3. If the job is in a terminal state, also fetch `mcp__cbx__cbx_result` and summarize the exit codes and review verdict.

If the job_id is unknown, list recent jobs with `mcp__cbx__cbx_list` so the user can pick one.
