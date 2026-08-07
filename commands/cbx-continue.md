---
description: Re-queue a cbx job to fix review.md or test failures.
argument-hint: "[job_id] [optional message]"
---

Resume cbx job `$ARGUMENTS` to address review findings or test failures.

1. First read `mcp__cbx__cbx_review` and `mcp__cbx__cbx_logs` for the job to understand what needs fixing. Check `mcp__cbx__cbx_status` for the `phase` — different phases need different inputs.
2. Call `mcp__cbx__cbx_continue` with:
   - `job_id`: the first argument
   - `message`: the second argument if provided, otherwise "请根据 review.md 修复问题，完成后重新运行验收命令。"
   - `context_snapshot`: refreshed context for the worker (required for `awaiting_clarification` / `adaptive_ask`; recommended whenever the plan changed).
   - `refresh_baseline: true`: only for `baseline_drift` / `dirty_baseline`, and only after confirming the current HEAD + dirty state are the intended new baseline.
   - `extra_rounds`: integer 1–100, **only** for `adaptive_max_rounds` (adaptive mode exhausted `max_rounds`). Rejected on any other phase. Confirm with the user before extending.
3. You will receive `{ job_id, status: "queued" }`. Track it to completion the same way as `/cbx-run` (poll `cbx_status`, then `cbx_result`).

Notes:
- For `repeated_failure`, do not auto-continue — the same root cause has failed 3+ times and needs a human decision.
- For `dependency_guard`, confirm with the user whether the dependency change is intended before continuing.
- For `verification_gate`, read `verified-progress.json` / `audit.json` (MCP resources) to see which acceptance criterion or evidence condition failed.
