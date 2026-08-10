# Evidence & Approval

## 1. Evidence System

Evidence is the **cryptographic proof** that a job completed with specific outputs. It prevents silent reversion of results between execution and approval.

### Evidence Artifacts

```typescript
// evidence.ts
const AUDIT_EVIDENCE_ARTIFACTS = [
  "complete.patch",
  "test.log",
  "review.md",
  "handback.md"
] as const;
```

These four artifacts are the source of truth for what the executor produced.

### Evidence Hash Computation

```typescript
// evidence.ts
async function evidenceHashes(directory: string): Promise<Record<string, string>> {
  // SHA-256 of each file that exists at path.join(directory, artifact)
  // Returns only artifacts that exist
}
```

Computed on-demand. Returns SHA-256 hashes keyed by artifact name.

---

## 2. PendingCompletion

Before `approvalBeforeComplete` is triggered, the system captures a snapshot of expected evidence:

```typescript
interface PendingCompletion {
  version: 1;
  evidenceHashes: Record<string, string>;  // SHA-256 of evidence artifacts
  worktreeSha256: string;                   // SHA-256 of worktree diff snapshot
  createdAt: string;                        // ISO timestamp
}
```

Written to `state.json` as `pendingCompletion`. Compared against live hashes on approval.

### worktreeSha256

```typescript
function worktreeSha256(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
```

Uses `snapshotDiff()` output from `git-ops.ts`. Any change to uncommitted worktree state invalidates the snapshot.

---

## 3. Completion Evidence Validation

```typescript
function completionEvidenceValid(
  context: JobContext,
  state: Record<string, unknown>,
  hashes: Record<string, string>
): boolean
```

Checks in order:
1. `state.testExitCode === 0`
2. Review verdict is PASS (or review not requested, or structured audit not enabled)
3. All required artifacts exist in `hashes`
4. If `structuredAuditRequested(context)`: `auditAllowsCompletion()` verifies the structured audit is complete

### Required Artifacts for Completion

```typescript
const required = [
  "complete.patch",
  "test.log",
  ...(context.reviewRequested ? ["review.md"] : [])
];
```

---

## 4. Structured Audit

Enabled when `context.reviewRequested && context.adaptive?.enabled`. The structured audit provides **criterion-level** verification, not just a pass/fail verdict.

### StructuredAudit Schema

```typescript
interface StructuredAudit {
  version: 1;
  completion: "complete" | "incomplete" | "blocked";
  cleanliness: "clean" | "suspect" | "violation";
  alignment: "aligned" | "unknown" | "needs_revision" | "invalid";
  criteria: CriterionJudgement[];
}

interface CriterionJudgement {
  id: string;
  criterion: string;
  status: "verified" | "unverified" | "blocked" | "invalidated";
  evidence: EvidenceReference[];
}

interface EvidenceReference {
  artifact: string;  // e.g., "handback.md"
  sha256: string;    // must match evidenceHashes[artifact]
}
```

### Criterion Definitions

`CriterionDefinition[]` comes from `context.taskContract?.criteria ?? []` (populated by Manager in adaptive mode). Each criterion is a string like `"Task produces unit tests for new functions"`.

### Audit Reconciliation

`reconcileVerifiedProgress()` merges a new audit with prior verified progress — a criterion that was verified in a previous round stays verified even if later rounds don't address it.

### Audit Completion Check

```typescript
function auditAllowsCompletion(
  audit: StructuredAudit | undefined,
  progress: VerifiedProgress,
  requiredEvidence: string[],
  evidenceHashes: Record<string, string>
): boolean
```

Passes only if:
- `audit.completion === "complete"`
- `audit.cleanliness !== "violation"`
- All `CriterionJudgement.status === "verified"`
- All evidence references have matching SHA-256 in `evidenceHashes`

---

## 5. Approval Flow

### Approval Handler

`approveJob()` in `src/approval.ts`:

```
approveJob(workspace, jobId)
  └→ withFileLock("run.lock")
      └→ approveJobLocked()
          ├→ Verify state.status === "awaiting_approval"
          ├→ Parse humanGate
          ├→ before_run gate:
          │   └→ writeApprovalState({ status: "queued", phase: "queued", approved: true })
          └→ before_complete gate:
              ├→ Parse pendingCompletion
              ├→ Load worktree path
              ├→ Compare evidenceHashes
              ├→ Compare worktreeSha256
              ├→ completionEvidenceValid() structural check
              ├→ Any mismatch → needs_fix (completion_evidence_stale)
              ├→ All pass → status: "done", phase: "done"
              ├→ If autoCommit → commitWorktree()
              └→ If !keepWorktree → cleanupWorktree()
```

### File Lock

`approveJob()` acquires a `run.lock` file lock before modifying state. This prevents concurrent approval attempts. `retries: 0` means it fails immediately if the lock is busy — the job is still running.

### Workdir Invariant (no `!` assertions)

In `approveJobLocked`, `workdir = context.isolated ? recorded?.path : workspace` where `recorded` comes from `worktree.json`. The path must exist for snapshot verification and `commitWorktree`:

- `snapshotMatches` narrows the type explicitly — `workdir !== undefined && existsSync(workdir) && worktreeSha256(await snapshotDiff(workdir))` — so TypeScript knows `workdir` is a non-empty string inside the expression without a `!` assertion.
- Reaching `commitWorktree(workdir, ...)` implies the evidence gate passed, which required `snapshotMatches === true` (hence `workdir` existed). That invariant is still guarded explicitly with `if (!workdir) throw ...` instead of `workdir!` — if a future gate change breaks the invariant, the error is diagnosable rather than a silent `undefined` argument.

> **Warning**: Do not reintroduce non-null assertions (`workdir!`) for paths that the evidence gate transitively guarantees. The explicit guard is what makes the "approval only after snapshot verification" contract auditable.

---

## 6. Human Gate

Defined in `src/human-gate.ts`. A `HumanGate` is a typed pause point that requires human intervention to resolve.

```typescript
interface HumanGate {
  reason: "before_run" | "completion" | "approval rejected because completion evidence changed";
  status: "waiting" | "approved" | "rejected";
  detail?: string;
  createdAt: string;
  resolvedAt?: string;
}
```

### Gate Creation

| Scenario | Gate |
|----------|------|
| `approvalBeforeRun: true` | `createHumanGate("before_run", { detail })` |
| `approvalBeforeComplete: true` | `createHumanGate("completion", { detail })` |
| Evidence mismatch on approval | `resolveHumanGate(gate, "approval rejected because ...")` → status: `"rejected"` |

### Repeated Failure Detection

```typescript
function trackFailure(
  gate: HumanGate,
  failureCount: number
): { shouldExtend: boolean; newMaxTurns?: number }
```

If the same job fails 3+ times (`failureCount >= 3`), the Manager's round limit is extended by `maxTurns` to allow more fix attempts.

---

## 7. Anti-Patterns

### Don't: Skip evidence hash verification in test environments

Even in dev, the evidence verification is the contract between executor output and approval. Mocking it in tests creates false confidence.

### Don't: Mark a job `done` without going through `approveJob()`

If a job is marked `done` directly (bypassing `approveJobLocked()`), `PendingCompletion` is never verified, and evidence integrity is not confirmed.

### Don't: Use `state.testExitCode` from a previous attempt

`testExitCode` must be from the final (latest) stage attempt. Stale exit codes would allow a passing test from an earlier attempt to pass evidence validation even if the final stage overwrote the test.
