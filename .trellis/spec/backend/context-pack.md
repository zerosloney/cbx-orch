# Context Pack

## 1. Overview

A **Context Pack** is a role-specific, token-budgeted projection of the full job state, used to minimize the context given to each agent (manager/executor/auditor). Each role receives only the information it needs.

Defined in `src/context-pack.ts`.

### Roles

| Role | Description |
|------|-------------|
| `manager` | Adaptive Manager receives current round, pending stages, recent failure, contract projection |
| `executor` | Stage executor receives goal, current stage task, context artifacts |
| `auditor` | Structured audit reviewer receives criteria definitions, verified progress, evidence hashes |

---

## 2. Common Context Pack Structure

```typescript
interface CommonContextPack {
  role: ContextRole;
  appVersion: string;
  jobId: string;
  workspace: string;
  createdAt: string;
  artifacts: ContextArtifactReference[];
  contract: TaskContractProjection | null;
  current: {
    goal: string;
    phase: string;
    status: string;
    testExitCode?: number;
    reviewVerdict?: string;
    humanGate?: HumanGateProjection;
  };
  contextBudget: ContextBudget;
  estimatedTokens: number;
  truncated: boolean;
}
```

### ContextArtifactReference

```typescript
interface ContextArtifactReference {
  name: string;    // e.g., "handback.md"
  lines: number;   // line count (for budget estimation)
  sha256: string;
}
```

### TaskContractProjection

```typescript
interface TaskContractProjection {
  goal: string;                      // never trimmed
  acceptanceCriteria: string[];      // never trimmed
  stages: AdaptiveTaskStage[];        // never trimmed (only in adaptive mode)
  constraints?: string[];            // trimmed first
  relevantFiles?: string[];          // trimmed second
  nonGoals?: string[];                // trimmed third
  assumptions?: string[];            // trimmed fourth
  rejectedOptions?: string[];         // trimmed last
  decisions?: string[];               // trimmed last
}
```

---

## 3. Role-Specific Packs

### ManagerContextPack

Extends `CommonContextPack` with manager-specific `current`:

```typescript
interface ManagerContextPack extends CommonContextPack {
  role: "manager";
  current: {
    round: number;
    maxRounds: number;
    pendingStages: string[];        // completed stage names
    recentFailure?: RecentFailure;  // last failed stage + error summary
  };
  contract: TaskContractProjection;
}
```

### ExecutorContextPack

```typescript
interface ExecutorContextPack extends CommonContextPack {
  role: "executor";
  current: {
    stage: AdaptiveTaskStage;        // the stage to execute
  };
  contract: TaskContractProjection | null;  // null in non-adaptive mode
}
```

### AuditorContextPack

```typescript
interface AuditorContextPack extends CommonContextPack {
  role: "auditor";
  current: {
    audit: StructuredAudit | null;        // prior audit if any
    verifiedProgress: VerifiedProgress;  // accumulated verified criteria
    pendingCriteria: string[];           // criteria not yet verified
  };
  contract: TaskContractProjection | null;
}
```

---

## 4. Token Budget

### Budget Structure

```typescript
interface ContextBudget {
  manager: number;   // default: 20_000
  executor: number;   // default: 22_000
  auditor: number;   // default: 18_000
  userInstructions?: number;  // fallback chars when over budget
}
```

### Budget Enforcement

`CONTEXT_PACK_MAX_CHARS = 24_000` is the JSON-serialization soft ceiling. Each role has its own budget.

### Trim Priority (low → high)

```
assumptions / rejectedOptions / decisions
→ constraints / relevantFiles
→ nonGoals
───────────────────────────── never trimmed ──────────────────────────────
goal / acceptanceCriteria / stages
```

`trimContract()` is called with the role's budget after the full pack (with current) is assembled, so the budget math includes the stage task text.

### Token Estimation

```typescript
// heuristic: ASCII ≈ chars/4, CJK ≈ chars/1.5
function estimateTokens(text: string): number
```

Accuracy ±20%. Used only for budget裁剪 decisions, not for billing.

---

## 5. Artifact References

Each role's pack lists `artifacts` — files the agent is permitted to read. Only files explicitly listed can be accessed:

```typescript
// Valid artifact names
type ContextArtifact =
  | "context-snapshot.md"
  | "complete.patch"
  | "test.log"
  | "review.md"
  | "handback.md"
  | "audit.json"
  | "verified-progress.json";

// Plus dynamic stage handback: "stage-<n>-<name>-handback.md"
```

The executor prompt (`promptFor()`) instructs the agent: *"只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。"*

---

## 6. Redaction

Sensitive fields in the job context are redacted before being packed:

```typescript
function contextRedactor(governance?: RuntimeConfig["governance"]): (text: string) => string
```

Configured via `.cbx.json` `governance.redactFields` (exact field name match) and `governance.redactPatterns` (regex).

Redaction is applied to: recent failure messages, human gate reasons, and any contract field that exceeds budget.

---

## 7. Pack Creation

### createManagerContextPack

```typescript
async function createManagerContextPack(input: {
  directory: string;
  jobId: string;
  context: JobContext;
  state: JobState;
  round: number;
  maxRounds: number;
  redact: (text: string) => string;
}): Promise<{ pack: ManagerContextPack; path: string }>
```

Steps:
1. `common()` → assemble base pack
2. Add manager-specific `current` (round, pending stages, recent failure)
3. `finalizeBudget()` → trim contract, compute estimatedTokens
4. `materialize()` → write JSON to `manager-context.json` in job dir

### createExecutorContextPack

```typescript
async function createExecutorContextPack(input: {
  directory: string;
  jobId: string;
  context: JobContext;
  state: JobState;
  stage: TaskStage;
  redact: (text: string) => string;
}): Promise<{ pack: ExecutorContextPack; path: string }>
```

### createAuditorContextPack

```typescript
async function createAuditorContextPack(input: {
  directory: string;
  jobId: string;
  context: JobContext;
  state: JobState;
  redact: (text: string) => string;
}): Promise<{ pack: AuditorContextPack; path: string }>
```

---

## 8. Parsing

```typescript
function parseContextPack(value: unknown): RoleContextPack
```

Validates and parses a deserialized pack. Used by `parseContextPack()` for parsing packed JSON back into typed objects. Throws on unknown fields or type violations.
