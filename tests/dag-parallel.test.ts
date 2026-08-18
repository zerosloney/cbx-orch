import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupStagesByDependency } from "../src/execution.js";
import type { TaskStage } from "../src/types.js";

describe("DAG Stage Parallelization (Phase 3 & 4)", () => {
  it("groupStagesByDependency splits stages into topological layers for parallel dispatch", () => {
    const stages: TaskStage[] = [
      { name: "lint", executor: "echo", task: "Run linter" },
      { name: "typecheck", executor: "echo", task: "Run tsc" },
      { name: "test", executor: "echo", task: "Run test suite", dependsOn: ["lint", "typecheck"] },
      { name: "build", executor: "echo", task: "Build bundle", dependsOn: ["test"] },
    ];

    const layers = groupStagesByDependency(stages);

    // Layer 0: [lint, typecheck] (mutually independent -> candidate for parallel execution)
    assert.equal(layers.length, 3);
    assert.equal(layers[0].length, 2);
    assert.deepEqual(layers[0].map((s) => s.name).sort(), ["lint", "typecheck"]);

    // Layer 1: [test]
    assert.equal(layers[1].length, 1);
    assert.equal(layers[1][0].name, "test");

    // Layer 2: [build]
    assert.equal(layers[2].length, 1);
    assert.equal(layers[2][0].name, "build");
  });
});
