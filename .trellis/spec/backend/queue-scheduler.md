# Queue & Scheduler

## 1. Overview

The queue is a **durable, file-based scheduler** for background job execution. It runs as a long-lived daemon process that dispatches workers, monitors heartbeats, and recovers from crashes.

All state is stored in `queue.json` at the workspace root (not in SQLite).

---

## 2. Queue Data Structures

### QueueFile

```typescript
interface QueueFile {
  maxConcurrent: number;   // max simultaneous running jobs
  paused: boolean;
  entries: QueueEntry[];   // ordered by enqueue time (+ priority)
  updatedAt: string;
}

interface QueueEntry {
  id: string;              // unique queue entry ID (not the jobId)
  jobId: string;           // maps to .cbx/jobs/<jobId>
  status: QueueEntryStatus;
  priority: number;        // higher = more priority
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

type QueueEntryStatus = "queued" | "running" | "done" | "failed" | "awaiting_approval" | "cancelled";
```

---

## 3. Dispatch Loop

`dispatchQueue()` is called by `serveQueue()` every `intervalMs` (default 30s) and also on `serveQueue()` startup.

### Startup Reclaim

On startup, `dispatchQueue()` iterates all `running` entries and checks:
1. Is the recorded PID still alive?
2. Is there a heartbeat file (`.cbx/jobs/<jobId>/heartbeat`) that is recent?

If a worker is dead (`!pidActive`) or its heartbeat is stale (`now - heartbeat > WORKER_HEARTBEAT_GRACE_MS`), it is marked for reclaim.

### Reclaim Flow

- `reclaims` counter incremented per entry
- If `reclaims >= MAX_RELAIMS (3)`: entry marked `failed`, never retried automatically
- Otherwise: entry reset to `queued` for redispatch

### Concurrency Control

`maxConcurrent` limits how many entries can have status `running` simultaneously. `dispatchQueue()` only spawns new workers when `runningCount < maxConcurrent`.

---

## 4. Worker Spawning

`spawnQueueWorker()` launches a subprocess:

```bash
node dist/src/cli.js run <jobId> --workspace <workspace> --extra <queueEntryId>
```

The worker is **detached** (no parent-child relationship after spawn) and writes its heartbeat to `.cbx/jobs/<jobId>/heartbeat`.

---

## 5. Heartbeat Protocol

```typescript
const WORKER_HEARTBEAT_GRACE_MS = 60_000;   // dead detection threshold
const WORKER_HEARTBEAT_STALE_MS = 45_000;   // when to consider stale
const SERVICE_LEASE_TTL_MS = 45_000;        // how long serveQueue holds the dispatch lock
```

Workers write a heartbeat file on startup and whenever the queue daemon polls. The daemon removes the heartbeat file when it observes the worker has exited.

### Dead Worker Detection

```
dispatchQueue()
  for each entry.status === "running":
    if !isPidActive(entry.pid):
      reclaim(entry, "pid gone")
    else if heartbeat stale (> 45s since last write):
      reclaim(entry, "heartbeat stale")
```

A pid being reused (Zombie/defunct) is indistinguishable from a true dead worker. The grace period + multiple reclaim attempts mitigates false positives.

---

## 6. Queue Service Lifecycle

```typescript
interface QueueService {
  done: Promise<void>;   // resolves when stopped
  stop(): Promise<void>;
}

async function serveQueue(
  runtime: QueueRuntime,
  workspaceInput: string,
  intervalMs = 30_000
): Promise<QueueService>
```

`serveQueue()` runs a `while (!stopped)` loop calling `dispatchQueue()` every `intervalMs`. It acquires a **service lease** via a lock file to prevent two daemons from running simultaneously.

---

## 7. Queue Operations

### Enqueue

```typescript
async function enqueueJob(
  runtime: QueueRuntime,
  workspaceInput: string,
  jobId: string,
  extra = "",
  priority = 0
): Promise<QueueEntry>
```

- Appends to `entries` with status `queued`
- `dispatchQueue()` will pick it up on next cycle

### Retry

```typescript
async function retryQueueJob(
  runtime: QueueRuntime,
  workspaceInput: string,
  jobId: string,
  priority = 0
): Promise<QueueEntry>
```

- Resets `status` to `queued`, resets `error`
- Does NOT reset `reclaims` counter
- Adds a new entry if the original still exists

### Cancel

```typescript
async function cancelQueueEntries(
  runtime: QueueRuntime,
  workspaceInput: string,
  jobId: string
): Promise<QueueFile>
```

- Marks all entries with `jobId` and status `queued/running/awaiting_approval` as `cancelled`
- Does NOT kill a running worker — use `cbx cancel <jobId>` for that

### Pause / Resume

- `pauseQueue()`: sets `paused: true` — `dispatchQueue()` will not spawn new workers
- `resumeQueue()`: sets `paused: false`

---

## 8. Job Status → Queue Status Mapping

| Job Status | Queue Entry Status |
|------------|-------------------|
| `queued` | `queued` |
| `running` | `running` |
| `awaiting_approval` | `awaiting_approval` |
| `done` | `done` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `needs_fix` / `review_failed` | (entry stays `running`; job transitions on approval/retry) |

---

## 9. Circuit Breaker

The `MAX_RELAIMS = 3` limit acts as a circuit breaker: after 3 crash-reclaims, the entry is permanently marked `failed` and requires manual `cbx retry` or `cbx cancel`.

This prevents infinite crash loops where a faulty job repeatedly consumes worker slots.

---

## 10. Queue API Facade

`src/queue-api.ts` exposes the queue operations with a `QueueRuntime` interface:

```typescript
interface QueueRuntime {
  workspace: () => string;
  queueFile: () => string;
}
```

This interface decouples queue operations from the storage layer, enabling testing without touching the filesystem.
