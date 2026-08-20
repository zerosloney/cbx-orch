import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderDoctor, runDoctor } from "../src/doctor.js";

async function doctorWorkspace(
  options: {
    config?: Record<string, unknown>;
    git?: boolean;
  } = {},
): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-doctor-"));
  const agents = path.join(workspace, ".cbx", "agents");
  await mkdir(agents, { recursive: true });
  const executable = path.join(workspace, "doctor-agent.mjs");
  await writeFile(executable, "process.exit(0);\n", "utf8");
  await writeFile(
    path.join(agents, "doctorfake.json"),
    JSON.stringify({
      name: "doctorfake",
      label: "Doctor Fake",
      candidates: [executable],
      args: ["{prompt}"],
    }),
    "utf8",
  );
  if (options.config)
    await writeFile(
      path.join(workspace, ".cbx.json"),
      JSON.stringify({ executor: "doctorfake", ...options.config }),
      "utf8",
    );
  if (options.git) {
    const result = spawnSync("git", ["init", "-b", "main"], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  return workspace;
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const found = report.checks.find((item) => item.id === id);
  assert.ok(found, `missing doctor check: ${id}`);
  return found;
}

test("fast profile passes with a Git workspace and a fake executor", async () => {
  const workspace = await doctorWorkspace({
    config: { profile: "fast" },
    git: true,
  });
  const report = await runDoctor(workspace);

  assert.equal(report.status, "pass");
  assert.equal(report.profile, "fast");
  assert.equal(check(report, "config").status, "pass");
  assert.equal(check(report, "profile").status, "pass");
  assert.equal(check(report, "git").status, "pass");
  assert.equal(check(report, "executor").status, "pass");
});

test("verified profile without a test command fails its profile check", async () => {
  const workspace = await doctorWorkspace({
    config: { profile: "verified" },
    git: true,
  });
  const report = await runDoctor(workspace);

  assert.equal(report.status, "fail");
  assert.equal(report.profile, "verified");
  assert.equal(check(report, "profile").status, "fail");
  assert.match(check(report, "profile").detail ?? "", /testCommand/);
  assert.equal(check(report, "git").status, "pass");
});

test("fast profile permits a non-Git workspace with a warning", async () => {
  const workspace = await doctorWorkspace({ config: { profile: "fast" } });
  const report = await runDoctor(workspace);

  assert.equal(report.status, "warn");
  assert.equal(check(report, "git").status, "warn");
  assert.equal(check(report, "executor").status, "pass");
});

test("legacy configuration without a profile remains diagnosable", async () => {
  const workspace = await doctorWorkspace({ config: {}, git: true });
  const report = await runDoctor(workspace);

  assert.equal(report.status, "pass");
  assert.equal(report.profile, undefined);
  assert.match(
    check(report, "profile").detail ?? "",
    /legacy\/current defaults/,
  );
});

test("renderDoctor includes overall status, check names, and details", async () => {
  const workspace = await doctorWorkspace({ config: { profile: "fast" } });
  const report = await runDoctor(workspace);
  const rendered = renderDoctor(report);

  assert.match(rendered, /Status: WARN/);
  assert.match(rendered, /git/);
  assert.match(rendered, /isolated=false/);
  assert.match(rendered, /executor/);
});
