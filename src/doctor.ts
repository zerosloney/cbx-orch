import { stat } from "node:fs/promises";
import path from "node:path";
import { discoverAgents, type AgentProbe } from "./agent-registry.js";
import { loadConfig, mergeConfig } from "./state.js";
import { gitRoot } from "./git-ops.js";
import { assertExecutionProfile, type ExecutionProfile } from "./profile.js";
import type { CbxConfig } from "./types.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  workspace: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
  profile?: ExecutionProfile;
}

type EffectiveConfig = ReturnType<typeof mergeConfig>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeCheck(
  id: string,
  status: DoctorStatus,
  message: string,
  detail?: string,
): DoctorCheck {
  return detail ? { id, status, message, detail } : { id, status, message };
}

function overallStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function availableProbe(probes: AgentProbe[]): AgentProbe | undefined {
  return probes.find((probe) => probe.available);
}

function findProbe(probes: AgentProbe[], name: string): AgentProbe | undefined {
  return probes.find(
    (probe) => probe.name === name || probe.aliases.includes(name),
  );
}

function profileOptions(config: CbxConfig, effective: EffectiveConfig) {
  return {
    profile: config.profile,
    isolated: effective.isolated,
    review: effective.review,
    testCommand: effective.testCommand,
    dependencyGuard: effective.dependencyGuard,
    approvalBeforeComplete: effective.approvalBeforeComplete,
    trustMode: effective.trustMode,
  };
}

/**
 * Perform read-only environment and workspace diagnostics.
 *
 * This function deliberately does not create jobs, invoke executors, or write
 * to the workspace.  It probes the same configuration and agent discovery
 * paths used by execution so the report reflects the effective runtime setup.
 */
export async function runDoctor(workspaceInput: string): Promise<DoctorReport> {
  const workspace = path.resolve(workspaceInput);
  const checks: DoctorCheck[] = [];

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(
    makeCheck(
      "runtime",
      Number.isInteger(nodeMajor) && nodeMajor >= 22 ? "pass" : "fail",
      Number.isInteger(nodeMajor) && nodeMajor >= 22
        ? `Node.js ${nodeVersion} 满足 >=22 要求。`
        : `Node.js ${nodeVersion} 不满足 >=22 要求。`,
    ),
  );

  let workspaceIsDirectory = false;
  try {
    workspaceIsDirectory = (await stat(workspace)).isDirectory();
  } catch {
    workspaceIsDirectory = false;
  }
  checks.push(
    makeCheck(
      "workspace",
      workspaceIsDirectory ? "pass" : "fail",
      workspaceIsDirectory
        ? "工作区存在且为目录。"
        : "工作区不存在或不是目录。",
      workspace,
    ),
  );

  let config: CbxConfig = {};
  try {
    config = await loadConfig(workspace);
    checks.push(makeCheck("config", "pass", "配置加载成功。"));
  } catch (error) {
    checks.push(
      makeCheck("config", "fail", "配置加载失败。", errorMessage(error)),
    );
  }

  let effective: EffectiveConfig;
  try {
    // If .cbx.json is malformed, retain the current defaults so independent
    // Git/agent checks can still report useful information alongside config's
    // failure.
    effective = mergeConfig(config, {});
  } catch (error) {
    effective = mergeConfig({}, {});
    checks.push(
      makeCheck(
        "profile",
        "fail",
        "无法合并有效配置并校验 profile。",
        errorMessage(error),
      ),
    );
  }

  if (!checks.some((check) => check.id === "profile")) {
    try {
      assertExecutionProfile(profileOptions(config, effective));
      if (config.profile === undefined) {
        checks.push(
          makeCheck(
            "profile",
            "pass",
            "未设置 execution profile，兼容使用当前默认值。",
            `legacy/current defaults: isolated=${String(effective.isolated)}, review=${String(effective.review)}, trustMode=${effective.trustMode}。`,
          ),
        );
      } else {
        checks.push(
          makeCheck(
            "profile",
            "pass",
            `execution profile=${config.profile} 的硬约束满足。`,
          ),
        );
      }
    } catch (error) {
      checks.push(
        makeCheck(
          "profile",
          "fail",
          "execution profile 硬约束不满足。",
          errorMessage(error),
        ),
      );
    }
  }

  let root: string | undefined;
  try {
    root = gitRoot(workspace);
  } catch (error) {
    checks.push(
      makeCheck("git", "fail", "Git 检查失败。", errorMessage(error)),
    );
  }
  if (!checks.some((check) => check.id === "git")) {
    if (root) {
      checks.push(makeCheck("git", "pass", "检测到 Git 根目录。", root));
    } else if (effective.isolated) {
      checks.push(
        makeCheck(
          "git",
          "fail",
          "未检测到 Git 根目录，但当前 effective isolated=true。",
        ),
      );
    } else {
      checks.push(
        makeCheck(
          "git",
          "warn",
          "未检测到 Git 根目录；当前 isolated=false，允许非 Git 工作区。",
        ),
      );
    }
  }

  let probes: AgentProbe[] = [];
  let discoveryErrors: string[] = [];
  let discoveryFailure: string | undefined;
  try {
    const discovered = await discoverAgents(workspace);
    probes = discovered.probes;
    discoveryErrors = discovered.errors;
  } catch (error) {
    discoveryFailure = errorMessage(error);
  }

  if (discoveryFailure) {
    checks.push(
      makeCheck("executor", "fail", "执行器发现失败。", discoveryFailure),
    );
  } else {
    const failures: string[] = [];
    const details: string[] = [];
    const executor = effective.executor ?? "codebuddy";
    if (executor === "auto") {
      const available = availableProbe(probes);
      if (!available) failures.push("executor=auto 时没有可用的编码执行器");
      else details.push(`auto 将使用可用执行器 ${available.name}`);
    } else {
      const probe = findProbe(probes, executor);
      if (!probe) failures.push(`找不到执行器 ${executor} 的注册项`);
      else if (!probe.available)
        failures.push(
          `${executor} 不可用${probe.error ? `：${probe.error}` : ""}`,
        );
      else details.push(`${executor} 可用`);
    }

    if (effective.review && effective.reviewExecutor) {
      const reviewExecutor = effective.reviewExecutor;
      if (reviewExecutor === "auto") {
        const available = availableProbe(probes);
        if (!available)
          failures.push("reviewExecutor=auto 时没有可用的审查执行器");
        else details.push(`reviewExecutor=auto 将使用 ${available.name}`);
      } else {
        const probe = findProbe(probes, reviewExecutor);
        if (!probe)
          failures.push(`找不到审查执行器 ${reviewExecutor} 的注册项`);
        else if (!probe.available)
          failures.push(
            `审查执行器 ${reviewExecutor} 不可用${probe.error ? `：${probe.error}` : ""}`,
          );
        else details.push(`审查执行器 ${reviewExecutor} 可用`);
      }
    }

    if (discoveryErrors.length)
      details.push(`注册 spec 警告：${discoveryErrors.join("；")}`);
    const status: DoctorStatus = failures.length
      ? "fail"
      : discoveryErrors.length
        ? "warn"
        : "pass";
    checks.push(
      makeCheck(
        "executor",
        status,
        failures.length
          ? "执行器检查未通过。"
          : discoveryErrors.length
            ? "执行器可用，但存在注册 spec 警告。"
            : "执行器检查通过。",
        [...failures, ...details].join("；") || undefined,
      ),
    );
  }

  if (effective.trustMode === "untrusted") {
    const runner = config.execution?.runner;
    const runnerPath = runner ? path.resolve(workspace, runner) : undefined;
    let runnerIsFile = false;
    if (runnerPath) {
      try {
        runnerIsFile = (await stat(runnerPath)).isFile();
      } catch {
        runnerIsFile = false;
      }
    }
    checks.push(
      makeCheck(
        "runner",
        runnerIsFile ? "pass" : "fail",
        runnerIsFile
          ? "untrusted 模式已配置 runner 文件。"
          : "untrusted 模式要求 execution.runner 指向文件。",
        runnerPath ?? "未配置 execution.runner。",
      ),
    );
  } else {
    checks.push(
      makeCheck("runner", "pass", "当前为 trusted 模式，跳过 runner 检查。"),
    );
  }

  return {
    workspace,
    status: overallStatus(checks),
    checks,
    ...(config.profile ? { profile: config.profile } : {}),
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [
    `Workspace: ${report.workspace}`,
    `Status: ${report.status.toUpperCase()}`,
    ...(report.profile ? [`Profile: ${report.profile}`] : []),
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
    if (check.detail) lines.push(`  ${check.detail}`);
  }
  return lines.join("\n");
}
