# Executor Token Estimation in result.json

## Goal

After every executor run, write a heuristic token estimate into `result.json` so users and tools can see how many tokens the coding agent consumed.

## Background

CBX already has a `context.tokenBudget` system for context pack trimming (see `context-pack.ts`), but it only measures the context *input* to the executor, not the *output* the executor consumes at runtime. The actual token burn happens in the coding CLI (codebuddy, opencode, omp, cline), whose output is captured in `agent.log`.

## Requirements

1. On task completion, read `agent.log` from the job directory
2. Apply the same heuristic as `estimateTokens()` in `context-pack.ts` (ASCII ≈ chars/4, CJK ≈ chars/1.5) to estimate total tokens consumed
3. Write `estimatedTokens` (number) into `result.json`
4. Zero dependencies — reuse existing `estimateTokens` from `context-pack.ts`
5. Pure data addition: no control flow changes, no new behaviors, no breaking changes to `result.json` schema

## Non-Goals

- No per-provider cost calculation (model pricing varies)
- No runtime budget enforcement (that's a separate feature)
- No per-stage token breakdown (aggregate across all stages for now)
- No changes to the executor's `agent.log` format

## Acceptance Criteria

1. `result.json` contains `estimatedTokens` (number) after task completion
2. Estimate is computed from `agent.log` content using the CJK-aware heuristic
3. If `agent.log` doesn't exist, `estimatedTokens` is `null` (not 0, not missing)
4. All existing tests pass
5. `result.json` readers (UI, MCP, CLI `cbx result`) display the new field without error

## Design

- In `writeResult()` in `src/result.ts`, add a read of `agent.log` and call `estimateTokens()` on the content
- Import `estimateTokens` from `./context-pack.js`
- Add `estimatedTokens` to the `result.json` output object
- No schema version bump needed — consumers already handle unknown fields