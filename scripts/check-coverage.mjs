#!/usr/bin/env node
// 覆盖率门槛检查：用 Node test runner 内置的 --test-coverage-* 阈值 flag 判定。
// 不再解析文本报告：Node 20/22 的覆盖率报告渲染在嵌套子目录（tui/components/）处会崩溃，
// 导致 all files 汇总行丢失。内置阈值 flag 在报告打印前独立判定退出码，不受渲染崩溃影响。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 测试补充（Windows/Node 24 实测 lines 76.5% / branch 61.72% / functions 78.11%），按 ~3% 跨平台余量上调
// floor 防 flaky；后续补测应继续同步上调。
// v0.16.0 调整：mcp-server inputSchema 描述已拆分至 src/mcp-schemas/ JSON 文件，
// JSON 文件运行时加载不计入 ts 覆盖率分母。lines% 实测 64.20，
// 阈值维持 64/58/71。后续计划补测 callTool handler 未覆盖分支以继续上调。
const thresholds = { lines: 64, branch: 58, functions: 71 };

const testsDirectory = path.join(root, "dist", "tests");
let testFiles;
try {
  testFiles = readdirSync(testsDirectory).filter(name => name.endsWith(".test.js")).map(name => path.join("dist", "tests", name));
} catch {
  console.error("coverage: dist/tests 不存在，请先运行 npm run build。");
  process.exit(1);
}
if (testFiles.length === 0) {
  console.error("coverage: dist/tests 下没有编译后的测试文件，请先运行 npm run build。");
  process.exit(1);
}

// 与 npm test 相同的 --test-concurrency=2：此前覆盖率运行用默认并发（=CPU 数），
// 大量 e2e 子进程并行把紧凑的墙钟假设（秒级执行器超时、百毫秒杀进程余量）拖爆，
// 在多核开发机与 Windows CI 上表现为随机时序失败。
const result = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=2",
  "--experimental-test-coverage",
  `--test-coverage-lines=${thresholds.lines}`,
  `--test-coverage-branches=${thresholds.branch}`,
  `--test-coverage-functions=${thresholds.functions}`,
  ...testFiles,
], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
// 透传测试进程输出（含覆盖率报告 + 阈值错误信息），供 CI artifact 存档。
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) {
  console.error(`coverage: 测试进程启动失败：${result.error.message}`);
  process.exit(1);
}

// Node 内置阈值 flag 在测试结束时以退出码反映判定：
//   0 = 全部达标，1 = 有未达标项（或测试失败）。
// 阈值判定独立于报告渲染，不受 Node 20/22 嵌套目录渲染崩溃影响。
if (result.status !== 0) {
  console.error(`coverage: 未达阈值（门槛 lines ${thresholds.lines}/branch ${thresholds.branch}/functions ${thresholds.functions}）或测试失败。`);
  process.exit(result.status ?? 1);
}

// 从输出中提取 all files 汇总行（如果报告完整渲染了）作为人类可读摘要；
// Node 20/22 渲染崩溃时该行可能缺失，此时不影响退出码判定。
const summaryLine = (result.stdout ?? "").split(/\r?\n/).find(line => /all files\s*\|/.test(line));
if (summaryLine) {
  const numbers = summaryLine.split("|").slice(1).map(cell => Number.parseFloat(cell.trim())).filter(value => Number.isFinite(value));
  if (numbers.length >= 3) {
    const [lines, branch, functions] = numbers;
    console.log(`coverage: lines ${lines}% / branch ${branch}% / functions ${functions}%（门槛 ${thresholds.lines}/${thresholds.branch}/${thresholds.functions}）✓`);
  }
} else {
  console.log(`coverage: 达标（门槛 ${thresholds.lines}/${thresholds.branch}/${thresholds.functions}）；报告渲染不完整，无法显示汇总行。`);
}
