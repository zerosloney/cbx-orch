import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createJob } from "../src/core.js";
import { loadPersistedState } from "../src/storage.js";

// =============================================================================
// MCP Server — JSON-RPC tool interface
// =============================================================================

const mcpPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mcp-server.js",
);

async function mcpCall(
  request: unknown,
  opts: { workspace?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [mcpPath], {
      stdio: "pipe",
      env: {
        ...process.env,
        ...(opts.workspace ? { CBX_WORKSPACE: opts.workspace } : {}),
      },
    });
    const outChunks: Array<Buffer> = [];
    const errChunks: Array<Buffer> = [];
    let settled = false;
    const settle = (
      err: Error | null,
      result?: Array<Record<string, unknown>>,
    ) => {
      if (settled) return;
      settled = true;
      proc.kill();
      if (err) reject(err);
      else resolve(result ?? []);
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      const text = Buffer.concat(outChunks).toString("utf8");
      const lines = text.trim().split(/\n/);
      if (lines.length >= 1 && lines[0]) {
        try {
          const parsed = lines
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          settle(null, parsed);
        } catch {
          /* wait for more data */
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    proc.on("error", (err) => settle(err));
    proc.on("exit", (code) => {
      if (!settled)
        settle(
          new Error(
            `MCP server exited with code ${code}: ${Buffer.concat(errChunks).toString("utf8")}`,
          ),
        );
    });
    proc.stdin.write(JSON.stringify(request) + "\n");
    setTimeout(() => settle(new Error("MCP call timed out")), 9_000);
  });
}

test("MCP: initialize returns server capabilities", async () => {
  const responses = await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  assert.equal(responses.length, 1);
  const response = responses[0] as Record<string, unknown>;
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  const result = response.result as Record<string, unknown>;
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.ok(result.capabilities);
});

test("MCP: ping returns empty result", async () => {
  const responses = await mcpCall({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.equal(responses.length, 1);
  assert.deepEqual((responses[0] as Record<string, unknown>).result, {});
});

test("MCP: tools/list returns all tool definitions", async () => {
  const responses = await mcpCall({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
  });
  assert.equal(responses.length, 1);
  const result = (responses[0] as Record<string, unknown>).result as {
    tools: Array<{ name: string }>;
  };
  const names = result.tools.map((t) => t.name);
  const expected = [
    "cbx_start",
    "cbx_status",
    "cbx_cancel",
    "cbx_approve",
    "cbx_list",
    "cbx_logs",
    "cbx_result",
    "cbx_queue",
    "cbx_retry",
    "cbx_review",
    "cbx_continue",
    "cbx_artifact",
    "cbx_queue_pause",
    "cbx_queue_resume",
    "cbx_review_gate",
    "cbx_clean",
  ];
  for (const name of expected)
    assert.ok(names.includes(name), `缺少工具：${name}`);
});

test("MCP: cbx_status returns job state for a real job", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-status-"));
  const job = await createJob({
    workspace,
    task: "MCP 状态测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-status",
  });
  const responses = await mcpCall(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cbx_status", arguments: { job_id: job.jobId } },
    },
    { workspace },
  );
  assert.equal(responses.length, 1);
  const result = (responses[0] as Record<string, unknown>).result as {
    content: Array<{ text: string }>;
  };
  const parsed = JSON.parse(result.content[0].text) as {
    jobId: string;
    status: string;
  };
  assert.equal(parsed.jobId, job.jobId);
  assert.equal(parsed.status, "queued");
});

test("MCP: cbx_list returns jobs in workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-list-"));
  await createJob({
    workspace,
    task: "MCP 列表测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-list-1",
  });
  await createJob({
    workspace,
    task: "MCP 列表测试 2",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-list-2",
  });
  const responses = await mcpCall(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "cbx_list", arguments: {} },
    },
    { workspace },
  );
  assert.equal(responses.length, 1);
  const result = (responses[0] as Record<string, unknown>).result as {
    content: Array<{ text: string }>;
  };
  const parsed = JSON.parse(result.content[0].text) as Array<{ jobId: string }>;
  assert.ok(parsed.length >= 2);
  assert.ok(parsed.some((j) => j.jobId === "mcp-list-1"));
  assert.ok(parsed.some((j) => j.jobId === "mcp-list-2"));
});

test("MCP: cbx_cancel on a non-existent job does not crash", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-cancel-"));
  const responses = await mcpCall(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "cbx_cancel", arguments: { job_id: "nonexistent" } },
    },
    { workspace },
  );
  assert.equal(responses.length, 1);
  assert.ok(
    (responses[0] as Record<string, unknown>).error !== undefined ||
      (responses[0] as Record<string, unknown>).result !== undefined,
  );
});

test("MCP: unknown method returns error", async () => {
  const responses = await mcpCall({
    jsonrpc: "2.0",
    id: 7,
    method: "unknown_method",
  });
  assert.equal(responses.length, 1);
  assert.ok((responses[0] as Record<string, unknown>).error !== undefined);
});

test("MCP: cbx_logs returns unified {job_id, events, next_offset} shape", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-logs-"));
  const job = await createJob({
    workspace,
    task: "MCP 日志测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-logs",
  });
  // createJob 不写 events.ndjson；先造两条事件再查
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({ event: "created", jobId: job.jobId, at: new Date().toISOString() })}\n${JSON.stringify({ event: "queued", jobId: job.jobId, at: new Date().toISOString() })}\n`,
    "utf8",
  );
  // 无 since（全量）
  const full = (
    await mcpCall(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "cbx_logs", arguments: { job_id: job.jobId } },
      },
      { workspace },
    )
  )[0] as Record<string, unknown>;
  const fullResult = full.result as { content: Array<{ text: string }> };
  const fullParsed = JSON.parse(fullResult.content[0].text) as {
    job_id: string;
    events: string[];
    next_offset: number;
  };
  assert.equal(fullParsed.job_id, job.jobId);
  assert.equal(fullParsed.events.length, 2);
  assert.equal(fullParsed.next_offset, fullParsed.events.length);
  // 有 since（增量）——同一形状
  const since = (
    await mcpCall(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "cbx_logs",
          arguments: { job_id: job.jobId, since: fullParsed.next_offset },
        },
      },
      { workspace },
    )
  )[0] as Record<string, unknown>;
  const sinceResult = since.result as { content: Array<{ text: string }> };
  const sinceParsed = JSON.parse(sinceResult.content[0].text) as {
    job_id: string;
    events: string[];
    next_offset: number;
  };
  assert.equal(sinceParsed.job_id, job.jobId);
  assert.equal(sinceParsed.events.length, 0);
  assert.equal(sinceParsed.next_offset, fullParsed.next_offset);
  // 非法 since 报错
  const bad = (
    await mcpCall(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "cbx_logs",
          arguments: { job_id: job.jobId, since: -1 },
        },
      },
      { workspace },
    )
  )[0] as Record<string, unknown>;
  assert.ok(bad.error !== undefined);
});

test("MCP: cbx_review on missing review.md returns JSON-RPC error", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-review-"));
  const job = await createJob({
    workspace,
    task: "MCP 审查测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-review",
  });
  const responses = await mcpCall(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "cbx_review", arguments: { job_id: job.jobId } },
    },
    { workspace },
  );
  assert.equal(responses.length, 1);
  // 缺 review.md 时错误传播（与 cbx_artifact/cbx_result 一致），不再吞异常返回占位文案
  assert.ok((responses[0] as Record<string, unknown>).error !== undefined);
});

test("MCP: cbx_clean returns cleaned:false idempotently for job without worktree", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-clean-"));
  const job = await createJob({
    workspace,
    task: "MCP 清理测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-clean",
  });
  const responses = await mcpCall(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "cbx_clean", arguments: { job_id: job.jobId } },
    },
    { workspace },
  );
  assert.equal(responses.length, 1);
  const result = (responses[0] as Record<string, unknown>).result as {
    content: Array<{ text: string }>;
  };
  const parsed = JSON.parse(result.content[0].text) as {
    job_id: string;
    cleaned: boolean;
  };
  assert.equal(parsed.job_id, job.jobId);
  // 无 worktree.json 记录 → 幂等返回 cleaned:false（与 CLI cbx clean 一致），不抛错
  assert.equal(parsed.cleaned, false);
});

test("MCP: notification without id does not receive a response", () => {
  // Per JSON-RPC 2.0, a notification without id must not produce a response.
  // The MCP server special-cases ping (always responds), so use a tool method.
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: "pipe",
    timeout: 5_000,
  });
  let output = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) + "\n",
  );
  proc.stdin.end();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 400);
    proc.on("exit", () => {
      clearTimeout(timer);
      proc.kill();
      resolve();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).then(() => {
    assert.equal(output.trim(), "");
  });
});

// =============================================================================
// SQLite Migration — rollback detection
// =============================================================================

test("migration: future schema version is rejected", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-migrate-rollback-"),
  );
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  // Create a SQLite database with a schema version higher than the current SCHEMA_VERSION (3)
  const dbPath = path.join(workspace, ".cbx", "state.sqlite");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  ).run(999, new Date().toISOString());
  db.close();
  // Any exported function that triggers database() → migrate() should throw
  await assert.rejects(
    () => loadPersistedState(workspace, "nonexistent"),
    /拒绝降级运行/,
  );
});

test("migration: normal schema version is accepted", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-migrate-normal-"),
  );
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  // Create a SQLite database with the complete schema at version 3 (current SCHEMA_VERSION)
  const dbPath = path.join(workspace, ".cbx", "state.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE queue_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE delivery_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE service_leases (name TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL, owner_token TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL, body_json TEXT NOT NULL, config_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER, last_error TEXT);
    CREATE INDEX delivery_outbox_available_idx ON delivery_outbox(available_at, id);
  `);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  ).run(3, new Date().toISOString());
  db.close();
  // loadPersistedState should succeed, returning undefined for a nonexistent job
  const result = await loadPersistedState(workspace, "nonexistent");
  assert.equal(result, undefined);
});
