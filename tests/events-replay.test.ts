import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { publishEvent } from "../src/observability.js";
import { replayEvents } from "../src/ui.js";

function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-events-"));
}

/** Mock ServerResponse：收集 write 调用。 */
function mockClient(): {
  client: { res: ServerResponse; pending: string[]; replaying: boolean };
  chunks: string[];
} {
  const chunks: string[] = [];
  const res = {
    write: (data: string) => {
      chunks.push(data);
      return true;
    },
  } as unknown as ServerResponse;
  return { client: { res, pending: [], replaying: false }, chunks };
}

// ---- publishEvent 写入的事件含递增 seq ----

test("publishEvent assigns monotonic seq across calls", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await publishEvent(workspace, "test.event", { value: 1 });
  await publishEvent(workspace, "test.event", { value: 2 });
  await publishEvent(workspace, "test.event", { value: 3 });
  const raw = await readFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    "utf8",
  );
  const lines = raw.trim().split("\n");
  const seqs = lines.map((line) => Number(JSON.parse(line).seq));
  assert.deepEqual(seqs, [1, 2, 3]);
});

test("publishEvent seq persists across process restart (metadata table)", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await publishEvent(workspace, "first.batch", { n: 1 });
  await publishEvent(workspace, "first.batch", { n: 2 });
  // 模拟"重启"：再次调用 publishEvent（metadata 表已持久化 seq=2）
  await publishEvent(workspace, "second.batch", { n: 3 });
  const raw = await readFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    "utf8",
  );
  const lines = raw.trim().split("\n");
  const seqs = lines.map((line) => Number(JSON.parse(line).seq));
  assert.deepEqual(seqs, [1, 2, 3]);
});

// ---- replayEvents：Last-Event-ID 回放 ----

test("replayEvents sends events with seq > cursor", async () => {
  const workspace = await makeWorkspace();
  const events = [
    {
      seq: 1,
      type: "job.state_changed",
      at: "2026-01-01T00:00:00Z",
      payload: { jobId: "a" },
    },
    {
      seq: 2,
      type: "job.state_changed",
      at: "2026-01-01T00:00:01Z",
      payload: { jobId: "b" },
    },
    {
      seq: 3,
      type: "job.state_changed",
      at: "2026-01-01T00:00:02Z",
      payload: { jobId: "c" },
    },
    {
      seq: 5,
      type: "job.state_changed",
      at: "2026-01-01T00:00:03Z",
      payload: { jobId: "d" },
    },
  ];
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 0, 2);
  const allData = chunks.join("");
  assert.ok(allData.includes('"jobId":"c"'), "should include seq=3 event");
  assert.ok(allData.includes('"jobId":"d"'), "should include seq=5 event");
  assert.ok(!allData.includes('"jobId":"a"'), "should NOT include seq=1");
  assert.ok(!allData.includes('"jobId":"b"'), "should NOT include seq=2");
});

test("replayEvents encodes compound id wsIndex:seq", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    JSON.stringify({ seq: 10, type: "test", payload: {} }) + "\n",
    "utf8",
  );
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 2, 5);
  const output = chunks.join("");
  // 复合 ID 应为 wsIndex:seq = 2:10
  assert.match(output, /id: 2:10\r?\n/);
});

test("replayEvents with cursor=0 replays all", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  const events = [
    { seq: 1, type: "a", payload: {} },
    { seq: 2, type: "b", payload: {} },
  ];
  await writeFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 0, 0);
  const allData = chunks.join("");
  assert.ok(allData.includes('"type":"a"'));
  assert.ok(allData.includes('"type":"b"'));
});

test("replayEvents truncates when exceeding maxReplayLines", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++)
    lines.push(JSON.stringify({ seq: i, type: "bulk", payload: { i } }));
  await writeFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    lines.join("\n") + "\n",
    "utf8",
  );
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 0, 0, 10);
  const allData = chunks.join("");
  assert.match(allData, /replay_truncated/);
  assert.ok(allData.includes('"i":41'));
  assert.ok(!allData.includes('"i":40'));
});

test("replayEvents skips events with no seq field", async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "events.ndjson"),
    [
      JSON.stringify({ type: "old_format", payload: {} }),
      JSON.stringify({ seq: 1, type: "new_format", payload: {} }),
    ].join("\n") + "\n",
    "utf8",
  );
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 0, 0);
  const allData = chunks.join("");
  assert.ok(!allData.includes("old_format"), "should skip events without seq");
  assert.ok(allData.includes("new_format"));
});

test("replayEvents handles missing events.ndjson gracefully", async () => {
  const workspace = await makeWorkspace();
  const { client, chunks } = mockClient();
  await replayEvents(workspace, client, 0, 0);
  assert.equal(chunks.length, 0);
});
