import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExecutionProfile,
  parseExecutionProfile,
  profileDefaults,
  validateExecutionProfile,
} from "../src/profile.js";

test("profile defaults: fast", () => {
  assert.deepEqual(profileDefaults("fast"), {
    isolated: false,
    review: false,
    dependencyGuard: false,
    approvalBeforeComplete: false,
    trustMode: "trusted",
    requireTestCommand: false,
  });
});

test("profile defaults: verified", () => {
  assert.deepEqual(profileDefaults("verified"), {
    isolated: true,
    review: true,
    dependencyGuard: false,
    approvalBeforeComplete: false,
    trustMode: "trusted",
    requireTestCommand: true,
  });
});

test("profile defaults: governed", () => {
  assert.deepEqual(profileDefaults("governed"), {
    isolated: true,
    review: true,
    dependencyGuard: true,
    approvalBeforeComplete: true,
    trustMode: "trusted",
    requireTestCommand: true,
  });
});

test("profile defaults: untrusted", () => {
  assert.deepEqual(profileDefaults("untrusted"), {
    isolated: true,
    review: true,
    dependencyGuard: true,
    approvalBeforeComplete: true,
    trustMode: "untrusted",
    requireTestCommand: true,
  });
});

test("parse and validate reject unknown profile with stable Chinese error", () => {
  for (const parse of [parseExecutionProfile, validateExecutionProfile]) {
    assert.throws(
      () => parse("strict"),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "未知 execution profile。可选值：fast、verified、governed、untrusted。",
    );
  }
});

test("verified requires isolation, review, and a test command", () => {
  assert.throws(
    () =>
      assertExecutionProfile({
        profile: "verified",
        isolated: false,
        review: true,
        testCommand: "npm test",
      }),
    /verified profile 要求 isolated=true/,
  );
  assert.throws(
    () =>
      assertExecutionProfile({
        profile: "verified",
        isolated: true,
        review: false,
        testCommand: "npm test",
      }),
    /verified profile 要求 review=true/,
  );
  for (const testCommand of [undefined, "", "  "]) {
    assert.throws(
      () =>
        assertExecutionProfile({
          profile: "verified",
          isolated: true,
          review: true,
          testCommand,
        }),
      /verified profile 要求 testCommand 非空/,
    );
  }
  assert.doesNotThrow(() =>
    assertExecutionProfile({
      profile: "verified",
      isolated: true,
      review: true,
      testCommand: "npm test",
      dependencyGuard: false,
      approvalBeforeComplete: false,
      trustMode: "trusted",
    }),
  );
});

test("governed requires dependency guard and completion approval", () => {
  const base = {
    profile: "governed" as const,
    isolated: true,
    review: true,
    testCommand: "npm test",
    dependencyGuard: true,
    approvalBeforeComplete: true,
    trustMode: "trusted" as const,
  };
  assert.throws(
    () => assertExecutionProfile({ ...base, dependencyGuard: false }),
    /governed profile 要求 dependencyGuard=true/,
  );
  assert.throws(
    () => assertExecutionProfile({ ...base, approvalBeforeComplete: false }),
    /governed profile 要求 approvalBeforeComplete=true/,
  );
  assert.doesNotThrow(() => assertExecutionProfile(base));
});

test("untrusted requires untrusted trust mode", () => {
  const base = {
    profile: "untrusted" as const,
    isolated: true,
    review: true,
    testCommand: "npm test",
    dependencyGuard: true,
    approvalBeforeComplete: true,
    trustMode: "trusted" as const,
  };
  assert.throws(
    () => assertExecutionProfile(base),
    /untrusted profile 要求 trustMode=untrusted/,
  );
  assert.doesNotThrow(() =>
    assertExecutionProfile({ ...base, trustMode: "untrusted" }),
  );
});

test("non-untrusted profiles reject untrusted trust mode", () => {
  for (const profile of ["fast", "verified", "governed"] as const) {
    assert.throws(
      () =>
        assertExecutionProfile({
          profile,
          isolated: profile !== "fast",
          review: profile !== "fast",
          testCommand: profile === "fast" ? undefined : "npm test",
          dependencyGuard: profile === "governed",
          approvalBeforeComplete: profile === "governed",
          trustMode: "untrusted",
        }),
      new RegExp(`${profile} profile 不允许 trustMode=untrusted`),
    );
  }
});

test("unset profile keeps legacy compatibility without extra validation", () => {
  assert.doesNotThrow(() =>
    assertExecutionProfile({
      isolated: false,
      review: false,
      testCommand: "",
      dependencyGuard: false,
      approvalBeforeComplete: false,
      trustMode: "untrusted",
    }),
  );
});
