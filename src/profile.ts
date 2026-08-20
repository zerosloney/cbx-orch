export const EXECUTION_PROFILES = [
  "fast",
  "verified",
  "governed",
  "untrusted",
] as const;

export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export type TrustMode = "trusted" | "untrusted";

export interface ExecutionProfileDefaults {
  isolated: boolean;
  review: boolean;
  dependencyGuard: boolean;
  approvalBeforeComplete: boolean;
  trustMode: TrustMode;
  requireTestCommand: boolean;
}

export interface ExecutionProfileOptions {
  profile?: unknown;
  isolated?: unknown;
  review?: unknown;
  testCommand?: unknown;
  dependencyGuard?: unknown;
  approvalBeforeComplete?: unknown;
  trustMode?: unknown;
}

const UNKNOWN_PROFILE_ERROR =
  "未知 execution profile。可选值：fast、verified、governed、untrusted。";

export function isExecutionProfile(
  value: unknown,
): value is ExecutionProfile {
  return (
    typeof value === "string" &&
    (EXECUTION_PROFILES as readonly string[]).includes(value)
  );
}

export function validateExecutionProfile(value: unknown): ExecutionProfile {
  if (!isExecutionProfile(value)) throw new Error(UNKNOWN_PROFILE_ERROR);
  return value;
}

export function parseExecutionProfile(value: unknown): ExecutionProfile {
  return validateExecutionProfile(value);
}

export function profileDefaults(
  profile: ExecutionProfile,
): ExecutionProfileDefaults {
  switch (validateExecutionProfile(profile)) {
    case "fast":
      return {
        isolated: false,
        review: false,
        dependencyGuard: false,
        approvalBeforeComplete: false,
        trustMode: "trusted",
        requireTestCommand: false,
      };
    case "verified":
      return {
        isolated: true,
        review: true,
        dependencyGuard: false,
        approvalBeforeComplete: false,
        trustMode: "trusted",
        requireTestCommand: true,
      };
    case "governed":
      return {
        isolated: true,
        review: true,
        dependencyGuard: true,
        approvalBeforeComplete: true,
        trustMode: "trusted",
        requireTestCommand: true,
      };
    case "untrusted":
      return {
        isolated: true,
        review: true,
        dependencyGuard: true,
        approvalBeforeComplete: true,
        trustMode: "untrusted",
        requireTestCommand: true,
      };
  }
}

export function assertExecutionProfile(
  options: ExecutionProfileOptions,
): void {
  if (options.profile === undefined) return;

  const profile = validateExecutionProfile(options.profile);
  const requiresVerification = profile !== "fast";

  if (requiresVerification && options.isolated !== true)
    throw new Error(`${profile} profile 要求 isolated=true。`);
  if (requiresVerification && options.review !== true)
    throw new Error(`${profile} profile 要求 review=true。`);
  if (
    requiresVerification &&
    (typeof options.testCommand !== "string" || !options.testCommand.trim())
  )
    throw new Error(`${profile} profile 要求 testCommand 非空。`);

  if (profile === "governed" || profile === "untrusted") {
    if (options.dependencyGuard !== true)
      throw new Error(`${profile} profile 要求 dependencyGuard=true。`);
    if (options.approvalBeforeComplete !== true)
      throw new Error(`${profile} profile 要求 approvalBeforeComplete=true。`);
  }

  if (profile === "untrusted" && options.trustMode !== "untrusted")
    throw new Error("untrusted profile 要求 trustMode=untrusted。");
  if (profile !== "untrusted" && options.trustMode === "untrusted")
    throw new Error(`${profile} profile 不允许 trustMode=untrusted。`);
}
