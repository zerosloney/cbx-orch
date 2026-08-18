import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeAllDatabases,
  closeDatabase,
  loadPersistedState,
  savePersistedState,
} from "../src/storage.js";

interface MinimalState { status: string }

test("closeDatabase releases SQLite handles and allows reopen", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-close-db-"));
  await savePersistedState(workspace, "j1", { status: "queued" });
  assert.equal((await loadPersistedState<MinimalState>(workspace, "j1"))?.status, "queued");
  await closeDatabase(workspace);
  // 关闭后应能重新打开并继续读写。
  await savePersistedState(workspace, "j1", { status: "running" });
  assert.equal((await loadPersistedState<MinimalState>(workspace, "j1"))?.status, "running");
  await closeDatabase(workspace);
});

test("closeAllDatabases releases all cached connections", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "cbx-close-all-a-"));
  const b = await mkdtemp(path.join(os.tmpdir(), "cbx-close-all-b-"));
  await savePersistedState(a, "j1", { status: "queued" });
  await savePersistedState(b, "j1", { status: "queued" });
  await closeAllDatabases();
  // 关闭后两个 workspace 都应能重新读写。
  await savePersistedState(a, "j1", { status: "done" });
  await savePersistedState(b, "j1", { status: "done" });
  assert.equal((await loadPersistedState<MinimalState>(a, "j1"))?.status, "done");
  assert.equal((await loadPersistedState<MinimalState>(b, "j1"))?.status, "done");
  await closeAllDatabases();
});
