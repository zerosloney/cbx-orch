import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTaskContract,
  validateStageDependencies,
} from "../src/validation.js";
import { groupStagesByDependency } from "../src/execution.js";
import type { TaskStage } from "../src/validation.js";

function stage(name: string, deps?: string[]): TaskStage {
  return { name, executor: "codebuddy", task: `do ${name}`, dependsOn: deps };
}

// ---- groupStagesByDependency：按依赖分层 ----

test("groupStagesByDependency: single stage returns single layer", () => {
  const layers = groupStagesByDependency([stage("only")]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].length, 1);
});

test("groupStagesByDependency: no dependencies returns single flat layer", () => {
  const layers = groupStagesByDependency([stage("a"), stage("b"), stage("c")]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].length, 3);
});

test("groupStagesByDependency: linear chain produces separate layers", () => {
  // a → b → c
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b", ["a"]),
    stage("c", ["b"]),
  ]);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers.map((l) => l.map((s) => s.name)),
    [["a"], ["b"], ["c"]],
  );
});

test("groupStagesByDependency: diamond dependency groups parallel stages", () => {
  // a → (b, c parallel) → d
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b", ["a"]),
    stage("c", ["a"]),
    stage("d", ["b", "c"]),
  ]);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers[0].map((s) => s.name),
    ["a"],
  );
  // b and c in same layer (order may vary)
  const layer1Names = layers[1].map((s) => s.name).sort();
  assert.deepEqual(layer1Names, ["b", "c"]);
  assert.deepEqual(
    layers[2].map((s) => s.name),
    ["d"],
  );
});

test("groupStagesByDependency: multiple independent roots in layer 0", () => {
  // a, b independent; c depends on both
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b"),
    stage("c", ["a", "b"]),
  ]);
  assert.equal(layers.length, 2);
  const layer0 = layers[0].map((s) => s.name).sort();
  assert.deepEqual(layer0, ["a", "b"]);
  assert.deepEqual(
    layers[1].map((s) => s.name),
    ["c"],
  );
});

// ---- validateStageDependencies：悬空与循环依赖 ----

test("validateStageDependencies: accepts valid DAG", () => {
  assert.doesNotThrow(() =>
    validateStageDependencies([stage("a"), stage("b", ["a"])]),
  );
});

test("validateStageDependencies: rejects dangling dependency", () => {
  assert.throws(
    () => validateStageDependencies([stage("a", ["nonexistent"])]),
    /依赖不存在的 stage/,
  );
});

test("validateStageDependencies: rejects self-dependency via normalizeTaskContract", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: ["a"] }],
      }),
    /不能依赖自身/,
  );
});

test("validateStageDependencies: rejects simple cycle A→B→A", () => {
  assert.throws(
    () => validateStageDependencies([stage("a", ["b"]), stage("b", ["a"])]),
    /循环依赖/,
  );
});

test("validateStageDependencies: rejects longer cycle A→B→C→A", () => {
  assert.throws(
    () =>
      validateStageDependencies([
        stage("a", ["c"]),
        stage("b", ["a"]),
        stage("c", ["b"]),
      ]),
    /循环依赖/,
  );
});

test("validateStageDependencies: accepts diamond (no cycle)", () => {
  assert.doesNotThrow(() =>
    validateStageDependencies([
      stage("a"),
      stage("b", ["a"]),
      stage("c", ["a"]),
      stage("d", ["b", "c"]),
    ]),
  );
});

// ---- normalizeTaskContract 集成：dependsOn 透传 ----

test("normalizeTaskContract: preserves dependsOn field", () => {
  const result = normalizeTaskContract({
    stages: [
      { name: "a", executor: "e", task: "t" },
      { name: "b", executor: "e", task: "t", dependsOn: ["a"] },
    ],
  });
  assert.deepEqual(result?.stages?.[1].dependsOn, ["a"]);
});

test("normalizeTaskContract: deduplicates dependsOn entries", () => {
  const result = normalizeTaskContract({
    stages: [
      { name: "a", executor: "e", task: "t" },
      { name: "b", executor: "e", task: "t", dependsOn: ["a", "a", "a"] },
    ],
  });
  assert.deepEqual(result?.stages?.[1].dependsOn, ["a"]);
});

test("normalizeTaskContract: rejects empty dependsOn array", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: [] }],
      }),
    /dependsOn 必须是非空字符串数组/,
  );
});

test("normalizeTaskContract: rejects non-string dependsOn element", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: [123] }],
      } as unknown as Parameters<typeof normalizeTaskContract>[0]),
    /dependsOn 必须是非空字符串数组/,
  );
});

test("normalizeTaskContract: rejects unknown stage field", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", bogus: true }],
      } as unknown as Parameters<typeof normalizeTaskContract>[0]),
    /不支持字段/,
  );
});
