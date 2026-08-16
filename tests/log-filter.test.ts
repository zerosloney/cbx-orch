import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import {
  CodeBuddyStreamFilter,
  QwenStreamFilter,
  GenericTextStreamFilter,
  createLogEventFilter,
  LineStreamAccumulator,
} from "../src/log-filter.js";
import { runProcess } from "../src/process-runner.js";

const testCtx = { jobId: "job-123", executor: "test-exec", stageName: "stage_0" };

describe("LogEventFilter Phase 1", () => {
  it("CodeBuddyStreamFilter parses stream-json events", () => {
    const filter = new CodeBuddyStreamFilter();

    // 1. thinking_delta
    const thoughtEvents = filter.processLine(
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Analyzing repository..." },
      }),
      testCtx,
    );
    assert.equal(thoughtEvents.length, 1);
    assert.equal(thoughtEvents[0].kind, "thought");
    assert.equal(thoughtEvents[0].content, "Analyzing repository...");

    // 2. text_delta
    const textEvents = filter.processLine(
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Refactoring completed." },
      }),
      testCtx,
    );
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].kind, "text");
    assert.equal(textEvents[0].content, "Refactoring completed.");

    // 3. tool_use
    const toolEvents = filter.processLine(
      JSON.stringify({
        type: "tool_use",
        name: "edit_file",
        input: { path: "src/index.ts" },
      }),
      testCtx,
    );
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].kind, "tool_use");
    assert.equal(toolEvents[0].meta?.toolName, "edit_file");
    assert.deepEqual(toolEvents[0].meta?.toolArgs, { path: "src/index.ts" });

    // 4. turn_start & turn_end
    const startEvents = filter.processLine(JSON.stringify({ type: "turn_start" }), testCtx);
    assert.equal(startEvents[0].kind, "turn_start");

    const endEvents = filter.processLine(JSON.stringify({ type: "turn_end" }), testCtx);
    assert.equal(endEvents[0].kind, "turn_end");

    // 5. error
    const errEvents = filter.processLine(
      JSON.stringify({ type: "error", message: "API limit exceeded" }),
      testCtx,
    );
    assert.equal(errEvents[0].kind, "error");
    assert.equal(errEvents[0].content, "API limit exceeded");

    // 6. raw non-JSON text
    const rawEvents = filter.processLine("plain text line", testCtx);
    assert.equal(rawEvents[0].kind, "text");
    assert.equal(rawEvents[0].content, "plain text line");
  });

  it("QwenStreamFilter parses Qwen stream-json format", () => {
    const filter = new QwenStreamFilter();

    // 1. reasoning_content
    const thoughtEvents = filter.processLine(
      JSON.stringify({
        choices: [{ delta: { reasoning_content: "Checking unit tests..." } }],
      }),
      testCtx,
    );
    assert.equal(thoughtEvents[0].kind, "thought");
    assert.equal(thoughtEvents[0].content, "Checking unit tests...");

    // 2. content & tool_calls
    const multiEvents = filter.processLine(
      JSON.stringify({
        choices: [
          {
            delta: {
              content: "I will call bash.",
              tool_calls: [
                {
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "npm test" }),
                  },
                },
              ],
            },
          },
        ],
      }),
      testCtx,
    );
    assert.equal(multiEvents.length, 2);
    assert.equal(multiEvents[0].kind, "text");
    assert.equal(multiEvents[0].content, "I will call bash.");
    assert.equal(multiEvents[1].kind, "tool_use");
    assert.equal(multiEvents[1].meta?.toolName, "bash");
    assert.deepEqual(multiEvents[1].meta?.toolArgs, { command: "npm test" });

    // 3. error
    const errEvents = filter.processLine(
      JSON.stringify({ error: { message: "Qwen Auth Failed" } }),
      testCtx,
    );
    assert.equal(errEvents[0].kind, "error");
    assert.equal(errEvents[0].content, "Qwen Auth Failed");
  });

  it("GenericTextStreamFilter matches heuristics and falls back to text", () => {
    const filter = new GenericTextStreamFilter();

    assert.equal(filter.processLine("Thought: I need to update package.json", testCtx)[0].kind, "thought");
    assert.equal(filter.processLine("[Reasoning] Checking dependencies", testCtx)[0].kind, "thought");

    const toolEvents = filter.processLine("[Tool: execute_command] npm run build", testCtx);
    assert.equal(toolEvents[0].kind, "tool_use");
    assert.equal(toolEvents[0].meta?.toolName, "execute_command");

    assert.equal(filter.processLine("Error: File not found", testCtx)[0].kind, "error");
    assert.equal(filter.processLine("Standard stdout output", testCtx)[0].kind, "text");
  });

  it("createLogEventFilter selects filter by executor name", () => {
    assert.equal(createLogEventFilter("codebuddy").name, "codebuddy");
    assert.equal(createLogEventFilter("CBC").name, "codebuddy");
    assert.equal(createLogEventFilter("qwen-code").name, "qwen");
    assert.equal(createLogEventFilter("opencode").name, "generic");
  });

  it("LineStreamAccumulator handles chunk fragmentation and flush", () => {
    const filter = new CodeBuddyStreamFilter();
    const accum = new LineStreamAccumulator(filter);

    const chunk1 = '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello ';
    const chunk2 = 'World!"}}\n{"type":"turn_end"}';

    const events1 = accum.feed(chunk1, testCtx);
    assert.equal(events1.length, 0); // 在换行符出现前不触发

    const events2 = accum.feed(chunk2, testCtx);
    assert.equal(events2.length, 1);
    assert.equal(events2[0].kind, "text");
    assert.equal(events2[0].content, "Hello World!");

    const flushed = accum.flush(testCtx);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].kind, "turn_end");
  });

  it("runProcess streams LogEvents via ProcessStreamOptions", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "log-filter-test-"));
    try {
      const filter = new GenericTextStreamFilter();
      const emittedEvents: string[] = [];

      const script = `
        console.log("Thought: Planning task execution");
        console.log("[Tool: run_test] npm test");
        console.log("Done!");
      `;

      const result = await runProcess(
        process.execPath,
        ["-e", script],
        tmpDir,
        10000,
        undefined,
        undefined,
        {
          filter,
          filterContext: testCtx,
          onLogEvent: (evt) => {
            emittedEvents.push(`${evt.kind}:${evt.content}`);
          },
        },
      );

      assert.equal(result.code, 0);
      assert.equal(emittedEvents.length, 3);
      assert.equal(emittedEvents[0], "thought:Planning task execution");
      assert.equal(emittedEvents[1], "tool_use:[Tool: run_test] npm test");
      assert.equal(emittedEvents[2], "text:Done!");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
