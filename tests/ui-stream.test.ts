import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createJob } from "../src/core.js";
import { createWebUiServer } from "../src/ui.js";

describe("Web UI Stream Events API (Phase 2)", () => {
  it("GET /api/jobs/:id/events returns incremental stream events", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ui-stream-test-"));
    const server = createWebUiServer(tmpDir, "127.0.0.1", 0);

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Create a job
      const job = await createJob({
        workspace: tmpDir,
        task: "Test stream events rendering",
        review: false,
        isolated: false,
        permissionMode: "auto",
        maxTurns: 10,
      });

      // 2. Fetch events when empty -> returns { events: [], next_offset: 0 }
      const res1 = await fetch(`${baseUrl}/api/jobs/${job.jobId}/events`);
      assert.equal(res1.status, 200);
      const data1 = (await res1.json()) as { events: string[]; next_offset: number };
      assert.deepEqual(data1.events, []);
      assert.equal(data1.next_offset, 0);

      // 3. Append stream events to job's events.ndjson
      const eventsFile = path.join(tmpDir, ".cbx", "jobs", job.jobId, "events.ndjson");
      const sampleEvt = {
        event: "executor_stream_event",
        jobId: job.jobId,
        kind: "thought",
        content: "Planning refactoring steps",
        at: new Date().toISOString(),
      };
      await appendFile(eventsFile, JSON.stringify(sampleEvt) + "\n", "utf8");

      // 4. Fetch events again -> returns stream event
      const res2 = await fetch(`${baseUrl}/api/jobs/${job.jobId}/events?since=0`);
      assert.equal(res2.status, 200);
      const data2 = (await res2.json()) as { events: string[]; next_offset: number };
      assert.equal(data2.events.length, 1);
      assert.equal(data2.next_offset, 1);

      const parsed = JSON.parse(data2.events[0]);
      assert.equal(parsed.event, "executor_stream_event");
      assert.equal(parsed.kind, "thought");
      assert.equal(parsed.content, "Planning refactoring steps");
    } finally {
      server.close();
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup for Windows SQLite lock */
      }
    }
  });
});
