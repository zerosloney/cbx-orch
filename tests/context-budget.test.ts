import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTEXT_PACK_MAX_CHARS,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  createManagerContextPack,
  createExecutorContextPack,
  parseContextPack,
} from "../src/context-pack.js";

function redact(text: string): string {
  return text;
}

async function makeDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-budget-"));
  return root;
}

// ---- estimateTokens：启发式 token 估算 ----

test("estimateTokens: empty string is zero", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: pure ASCII roughly chars/4", () => {
  // 40 ASCII chars → ~10 tokens
  const text = "a".repeat(40);
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 8 && tokens <= 12, `expected ~10, got ${tokens}`);
});

test("estimateTokens: pure CJK gets higher per-char weight", () => {
  // 15 CJK chars → ~10 tokens (15/1.5)
  const text = "任".repeat(15);
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 8 && tokens <= 12, `expected ~10, got ${tokens}`);
});

test("estimateTokens: mixed content sums both estimates", () => {
  const mixed = "a".repeat(20) + "任".repeat(6);
  // 20/4 + 6/1.5 = 5 + 4 = 9
  const tokens = estimateTokens(mixed);
  assert.ok(tokens >= 7 && tokens <= 12, `expected ~9, got ${tokens}`);
});

test("estimateTokens: CJK punctuation and kana counted as CJK", () => {
  // U+3000 range and U+3040 range
  const text = "　あア漢";
  const tokens = estimateTokens(text);
  assert.ok(
    tokens > 0,
    "CJK punctuation and kana should produce positive estimate",
  );
});

// ---- 预算内不裁剪 ----

test("normal-sized pack within budget is not truncated", async () => {
  const directory = await makeDir();
  // 构造一个小 artifact 供 references 使用
  await writeFile(
    path.join(directory, "context-snapshot.md"),
    "small snapshot",
    "utf8",
  );
  const { pack } = await createManagerContextPack({
    directory,
    taskContract: {
      goal: "simple goal",
      acceptanceCriteria: ["criterion one"],
    },
    userInstructions: "do the thing",
    artifactNames: ["context-snapshot.md"],
    redact,
    round: 1,
    maxRounds: 4,
  });
  assert.equal(pack.truncated, undefined);
  assert.ok(
    typeof pack.estimatedTokens === "number" && pack.estimatedTokens > 0,
  );
  // round-trip through parseContextPack
  assert.deepEqual(parseContextPack(pack), pack);
});

// ---- 超预算裁剪 ----

test("oversized taskContract triggers truncation of low-priority fields", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  // 构造大 taskContract：assumptions + rejectedOptions + decisions + constraints 都有大量内容
  const big = "x".repeat(5000);
  const { pack } = await createManagerContextPack({
    directory,
    taskContract: {
      goal: "core goal that stays",
      acceptanceCriteria: ["core criterion"],
      assumptions: [big, big],
      rejectedOptions: [big],
      decisions: [big],
      constraints: [big, big],
      relevantFiles: [big],
      nonGoals: [big],
    },
    userInstructions: big.slice(0, 3000),
    artifactNames: ["context-snapshot.md"],
    redact,
    budget: {
      manager: 200,
      executor: DEFAULT_TOKEN_BUDGET.executor,
      auditor: DEFAULT_TOKEN_BUDGET.auditor,
    },
    round: 1,
    maxRounds: 4,
  });
  assert.equal(pack.truncated, true);
  // goal + acceptanceCriteria 永不裁剪
  assert.equal(pack.taskContract?.goal, "core goal that stays");
  assert.deepEqual(pack.taskContract?.acceptanceCriteria, ["core criterion"]);
  // 低优先字段应被裁掉（assumptions/rejectedOptions/decisions 最先删）
  assert.equal(pack.taskContract?.assumptions, undefined);
  assert.equal(pack.taskContract?.rejectedOptions, undefined);
  assert.equal(pack.taskContract?.decisions, undefined);
  assert.ok(typeof pack.estimatedTokens === "number");
});

test("userInstructions shrunk when budget still exceeded after contract trimming", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  const huge = "y".repeat(10000);
  const { pack } = await createManagerContextPack({
    directory,
    taskContract: { goal: "g" },
    userInstructions: huge,
    artifactNames: ["context-snapshot.md"],
    redact,
    budget: {
      manager: 50,
      executor: DEFAULT_TOKEN_BUDGET.executor,
      auditor: DEFAULT_TOKEN_BUDGET.auditor,
    },
    round: 1,
    maxRounds: 4,
  });
  assert.equal(pack.truncated, true);
  // userInstructions 应回缩到 1000 字符（BUDGET_USER_INSTRUCTIONS_FALLBACK_CHARS）
  assert.ok(
    pack.userInstructions.length <= 1000,
    `expected <= 1000, got ${pack.userInstructions.length}`,
  );
});

test("recentFailure retryReason trimmed when over budget", async () => {
  const directory = await makeDir();
  await writeFile(path.join(directory, "context-snapshot.md"), "x", "utf8");
  const huge = "z".repeat(8000);
  const { pack } = await createExecutorContextPack({
    directory,
    taskContract: { goal: "g" },
    recentFailure: {
      phase: "testing",
      error: "fail",
      retryReason: huge,
      count: 3,
    },
    userInstructions: "",
    artifactNames: ["context-snapshot.md"],
    redact,
    stage: { name: "s", executor: "codebuddy", task: "do" },
    attempt: 1,
    budget: {
      manager: DEFAULT_TOKEN_BUDGET.manager,
      executor: 100,
      auditor: DEFAULT_TOKEN_BUDGET.auditor,
    },
  });
  // retryReason 应被清空（可能整个 recentFailure 仍在但 retryReason=null）
  assert.ok(
    pack.truncated === true ||
      pack.recentFailure?.retryReason === null ||
      pack.recentFailure?.retryReason === undefined,
  );
});

// ---- parseContextPack 接受新字段 ----

test("parseContextPack accepts truncated and estimatedTokens fields", () => {
  const pack = {
    version: 1,
    projection: true,
    role: "manager" as const,
    taskContract: null,
    verifiedProgress: null,
    audit: null,
    recentFailure: null,
    userInstructions: "",
    artifacts: [],
    current: { round: 1, maxRounds: 2, remainingRounds: 1 },
    truncated: true,
    estimatedTokens: 1234,
  };
  const parsed = parseContextPack(pack);
  assert.equal(parsed.truncated, true);
  assert.equal((parsed as { estimatedTokens?: number }).estimatedTokens, 1234);
});

test("parseContextPack rejects invalid truncated type", () => {
  assert.throws(
    () =>
      parseContextPack({
        version: 1,
        projection: true,
        role: "manager",
        taskContract: null,
        verifiedProgress: null,
        audit: null,
        recentFailure: null,
        userInstructions: "",
        artifacts: [],
        current: { round: 1, maxRounds: 2, remainingRounds: 1 },
        truncated: "yes",
      }),
    /truncated/,
  );
});

test("parseContextPack rejects invalid estimatedTokens", () => {
  assert.throws(
    () =>
      parseContextPack({
        version: 1,
        projection: true,
        role: "manager",
        taskContract: null,
        verifiedProgress: null,
        audit: null,
        recentFailure: null,
        userInstructions: "",
        artifacts: [],
        current: { round: 1, maxRounds: 2, remainingRounds: 1 },
        estimatedTokens: -5,
      }),
    /estimatedTokens/,
  );
});

test("CONTEXT_PACK_MAX_CHARS hard ceiling still enforced", () => {
  const oversize = "a".repeat(CONTEXT_PACK_MAX_CHARS + 100);
  assert.throws(
    () =>
      parseContextPack({
        version: 1,
        projection: true,
        role: "manager",
        taskContract: null,
        verifiedProgress: null,
        audit: null,
        recentFailure: null,
        userInstructions: oversize,
        artifacts: [],
        current: { round: 1, maxRounds: 2, remainingRounds: 1 },
      }),
    /字符上限/,
  );
});
