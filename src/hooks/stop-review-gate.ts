#!/usr/bin/env node
/**
 * Stop hook gate：主会话 agent 回合结束时触发。
 * 读 .cbx.json 的 reviewGate.enabled；为 true 时对主工作区未提交改动跑独立 review。
 * fail-open：任何异常都放行，gate 是增强不是阻塞阀门。
 *
 * 输入（stdin JSON）：{ hook_event_name, cwd, last_assistant_message, ... }
 * 输出：{ decision: "block", reason } 阻塞；无输出（或空）放行。
 */
import { stopReviewGateHook } from "../review-gate.js";

interface StopHookInput { hook_event_name?: string; cwd?: string; session_id?: string; last_assistant_message?: string; [key: string]: unknown }

async function readStdin(): Promise<string> {
  return await new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    // 无 stdin（如直接 node 调用）立即结束
    process.stdin.on("error", () => resolve(""));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: StopHookInput = {};
  if (raw.trim()) {
    try { input = JSON.parse(raw) as StopHookInput; } catch { /* 忽略非 JSON stdin */ }
  }
  const workspace = input.cwd ?? process.env.CBX_WORKSPACE ?? process.cwd();
  const decision = await stopReviewGateHook(workspace);
  if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
}

main().catch(error => {
  process.stderr.write(`cbx stop-review-gate 异常（fail-open 放行）：${error instanceof Error ? error.message : String(error)}\n`);
  // 不设非 0 退出码：Stop hook 退出码非 0 行为未定义，fail-open 走放行
});