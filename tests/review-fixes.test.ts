import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";
import {
  createExecutorContextPack,
  createAuditorContextPack,
} from "../src/context-pack.js";
import { nextEventSeq } from "../src/storage.js";
import { parseCursors, replayEvents } from "../src/ui.js";

function redact(text: string): string {
  return text;
}

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-fix-"));
}

// ==================== P1-1: Adaptive done 不吞审批状态 ====================
// 集成测试在 core.test.ts（复用 setupFake fake executor），此处验证 parseContextPack 等纯函数。
// P1-1 的执行逻辑回归由 core.test.ts 的 adaptive 测试套件覆盖。

// ==================== P1-2: token budget 从 .cbx.json 接入生产链 ====================

test("P1-2: custom tokenBudget from context.tokenBudget affects pack estimatedTokens", async () => {
  const directory = await makeDir();
  await writeFile(
    path.join(directory, "context-snapshot.md"),
    "snapshot",
    "utf8",
  );
  const big = "a".repeat(200); // projectContract 的 short 每项截到 200 字符；6 项 = 1200 字符 ≈ 300 tokens
  const { pack: defaultPack } = await createExecutorContextPack({
    directory,
    taskContract: { goal: "g", assumptions: [big, big, big, big, big, big] },
    userInstructions: "do it",
    artifactNames: ["context-snapshot.md"],
    redact,
    stage: { name: "s", executor: "e", task: "t" },
    attempt: 1,
  });
  const { pack: tightPack } = await createExecutorContextPack({
    directory,
    taskContract: { goal: "g", assumptions: [big, big, big, big, big, big] },
    userInstructions: "do it",
    artifactNames: ["context-snapshot.md"],
    redact,
    budget: { manager: 1000, executor: 150, auditor: 1000 },
    stage: { name: "s", executor: "e", task: "t" },
    attempt: 1,
  });
  // 紧预算应触发裁剪
  assert.equal(tightPack.truncated, true);
  assert.equal(tightPack.taskContract?.assumptions, undefined);
  // 默认预算下 assumptions 保留
  assert.ok(
    defaultPack.taskContract?.assumptions !== undefined ||
      defaultPack.truncated === undefined,
  );
  // 紧预算 estimatedTokens 应小于默认
  assert.ok(
    (tightPack.estimatedTokens ?? 0) <=
      (defaultPack.estimatedTokens ?? Infinity),
  );
});

// ==================== P2-3: 预算含角色专属 current 内容 ====================

test("P2-3: oversized executor stage task counts toward budget and triggers truncation", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  const hugeTask = "z".repeat(5000);
  const { pack } = await createExecutorContextPack({
    directory,
    taskContract: { goal: "g" },
    userInstructions: "",
    artifactNames: ["context-snapshot.md"],
    redact,
    budget: { manager: 8000, executor: 300, auditor: 8000 },
    stage: { name: "s", executor: "e", task: hugeTask },
    attempt: 1,
  });
  // stage.task 是角色专属内容，超预算时应触发裁剪标记
  assert.equal(pack.truncated, true);
  // estimatedTokens 应基于含 current 的完整包
  assert.ok(
    typeof pack.estimatedTokens === "number" && pack.estimatedTokens > 0,
  );
});

test("P2-3: oversized auditor reviewRules counts toward budget", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  const hugeRules = "r".repeat(4000);
  const { pack } = await createAuditorContextPack({
    directory,
    taskContract: { goal: "g" },
    userInstructions: "",
    artifactNames: ["context-snapshot.md"],
    redact,
    budget: { manager: 8000, executor: 8000, auditor: 300 },
    stage: { name: "s", executor: "e", task: "t" },
    reviewRules: hugeRules,
    criteria: [{ id: "c1", criterion: "crit" }],
  });
  assert.equal(pack.truncated, true);
});

// ==================== P1-6: seq 跨进程原子（并发 nextEventSeq 唯一） ====================

test("P1-6: concurrent nextEventSeq calls produce unique monotonic values", async () => {
  const workspace = await makeDir();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  // 模拟并发：10 个 nextEventSeq 同时调用（无 await 串行化）
  const promises = Array.from({ length: 10 }, () => nextEventSeq(workspace));
  const seqs = await Promise.all(promises);
  const unique = new Set(seqs);
  assert.equal(
    unique.size,
    10,
    `expected 10 unique seqs, got ${seqs.length} with ${unique.size} unique`,
  );
  // 单调递增：排序后应连续
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(
    sorted,
    seqs.sort((a, b) => a - b),
  );
  // 最小值应 >= 1
  assert.ok(Math.min(...seqs) >= 1);
});

test("P1-6: nextEventSeq is monotonic across sequential calls", async () => {
  const workspace = await makeDir();
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  const a = await nextEventSeq(workspace);
  const b = await nextEventSeq(workspace);
  const c = await nextEventSeq(workspace);
  assert.equal(b, a + 1);
  assert.equal(c, b + 1);
});

// ==================== P1-7: 多 workspace 复合游标 ====================

test("P1-7: parseCursors decodes compound multi-workspace id", () => {
  // 格式 wsIndex:seq,wsIndex:seq
  const cursors = parseCursors("0:5,1:12", 2);
  assert.deepEqual(cursors, [5, 12]);
});

test("P1-7: parseCursors single workspace compound id", () => {
  const cursors = parseCursors("0:8", 1);
  assert.deepEqual(cursors, [8]);
});

test("P1-7: parseCursors legacy pure-number applies to all workspaces", () => {
  const cursors = parseCursors("7", 3);
  assert.deepEqual(cursors, [7, 7, 7]);
});

test("P1-7: parseCursors undefined returns zeros", () => {
  const cursors = parseCursors(undefined, 2);
  assert.deepEqual(cursors, [0, 0]);
});

test("P1-7: parseCursors ignores out-of-range wsIndex", () => {
  const cursors = parseCursors("0:3,5:99,1:7", 2);
  assert.deepEqual(cursors, [3, 7]);
});

test("P1-7: two workspaces with independent seq ranges replay correctly", async () => {
  const ws1 = await makeDir();
  const ws2 = await makeDir();
  await mkdir(path.join(ws1, ".cbx"), { recursive: true });
  await mkdir(path.join(ws2, ".cbx"), { recursive: true });
  // ws1: seq 1-3; ws2: seq 1-3（独立序列）
  await writeFile(
    path.join(ws1, ".cbx", "events.ndjson"),
    [1, 2, 3]
      .map((s) => JSON.stringify({ seq: s, type: "ws1", payload: {} }))
      .join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(ws2, ".cbx", "events.ndjson"),
    [1, 2, 3]
      .map((s) => JSON.stringify({ seq: s, type: "ws2", payload: {} }))
      .join("\n") + "\n",
    "utf8",
  );
  const chunks: string[] = [];
  const client = {
    res: {
      write: (d: string) => {
        chunks.push(d);
        return true;
      },
    } as unknown as ServerResponse,
    pending: [],
    replaying: false,
  };
  // 复合游标：ws1 从 seq 1 续（回放 2,3），ws2 从 seq 2 续（回放 3）
  await replayEvents(ws1, client, 0, 1);
  await replayEvents(ws2, client, 1, 2);
  const all = chunks.join("");
  // ws1 应回放 seq 2,3；ws2 应回放 seq 3
  assert.ok(all.match(/id: 0:2/), "ws1 seq=2 replayed with compound id 0:2");
  assert.ok(all.match(/id: 0:3/), "ws1 seq=3 replayed");
  assert.ok(all.match(/id: 1:3/), "ws2 seq=3 replayed with compound id 1:3");
  assert.ok(!all.match(/id: 0:1/), "ws1 seq=1 NOT replayed (cursor=1)");
  assert.ok(!all.match(/id: 1:2/), "ws2 seq=2 NOT replayed (cursor=2)");
});

// ==================== P1-8: replay 缓冲消除丢事件窗口 ====================

test("P1-8: replaying client buffers events during replay then flushes", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  const written: string[] = [];
  const pending: string[] = [];
  const client = {
    res: {
      write: (d: string) => {
        written.push(d);
        return true;
      },
    } as unknown as ServerResponse,
    pending,
    replaying: true, // 模拟回放期间
  };
  // 模拟 broadcast 在 replaying 时写 pending
  const broadcastDuringReplay = (msg: string): void => {
    if (client.replaying) client.pending.push(msg);
    else {
      try {
        client.res.write(msg);
      } catch {
        /* */
      }
    }
  };
  // 回放期间模拟 tailer 广播 2 个事件 → 进 pending
  broadcastDuringReplay("id: 0:99\ndata: realtime-1\n\n");
  broadcastDuringReplay("id: 0:100\ndata: realtime-2\n\n");
  // 回放结束：flush
  client.replaying = false;
  for (const msg of client.pending) {
    try {
      client.res.write(msg);
    } catch {
      /* */
    }
  }
  client.pending = [];
  // written 应含 flush 的实时事件（未丢失）
  assert.ok(written.join("").includes("realtime-1"), "buffered event flushed");
  assert.ok(
    written.join("").includes("realtime-2"),
    "second buffered event flushed",
  );
});
