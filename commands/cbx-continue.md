---
description: Re-queue a cbx job to fix review.md or test failures.
argument-hint: "[job_id] [optional message]"
---

Resume cbx job `$ARGUMENTS` to address review findings or test failures.

1. First read `mcp__cbx__cbx_review` and `mcp__cbx__cbx_logs` for the job to understand what needs fixing.
2. Call `mcp__cbx__cbx_continue` with:
   - `job_id`: the first argument
   - `message`: the second argument if provided, otherwise "请根据 review.md 修复问题，完成后重新运行验收命令。"
3. You will receive `{ job_id, status: "queued" }`. Track it to completion the same way as `/cbx-run` (poll `cbx_status`, then `cbx_result`).
