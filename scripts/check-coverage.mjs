#!/usr/bin/env node
// 覆盖率门槛检查：运行全量测试并校验 "all files" 汇总行达到最低阈值。
// 用脚本解析而非 --test-coverage-* 阈值 flag，保持对 Node 20（CI 矩阵最低版本）的兼容。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 门槛作为覆盖率 floor：略低于 Node 20/22 实测下限（V8 覆盖率插桩在 20/22 上数值偏低，
// 属数值波动非真实差异，见 issue #6），防止覆盖率无声回退。
// feat visualization 新代码（formatting/TUI/ui）已实质覆盖（formatting 98%、TUI ~95%、ui 83%），
// 整体数字受预先存在的 cli.js 历史欠债（~55%）拖累；后续补测应同步上调本门槛。
const thresholds = { lines: 66, branch: 43, functions: 67 };

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

const result = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) {
  console.error(`coverage: 测试进程启动失败：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const summaryLine = (result.stdout ?? "").split(/\r?\n/).find(line => /^ℹ all files\s*\|/.test(line));
if (!summaryLine) {
  console.error("coverage: 未在输出中找到 all files 汇总行，无法校验阈值。");
  process.exit(1);
}
const numbers = summaryLine.split("|").slice(1).map(cell => Number.parseFloat(cell.trim())).filter(value => Number.isFinite(value));
if (numbers.length < 3) {
  console.error(`coverage: all files 汇总行数值列不足：${summaryLine}`);
  process.exit(1);
}
// Node 覆盖率报告固定列序（v20/v22/v24 一致）：line % | branch % | funcs %。
const [lines, branch, functions] = numbers;
const failures = [
  lines < thresholds.lines ? `lines ${lines}% < ${thresholds.lines}%` : undefined,
  branch < thresholds.branch ? `branch ${branch}% < ${thresholds.branch}%` : undefined,
  functions < thresholds.functions ? `functions ${functions}% < ${thresholds.functions}%` : undefined,
].filter(Boolean);
console.log(`coverage: lines ${lines}% / branch ${branch}% / functions ${functions}%（门槛 ${thresholds.lines}/${thresholds.branch}/${thresholds.functions}）`);
if (failures.length > 0) {
  console.error(`coverage: 低于最低阈值：${failures.join("；")}`);
  process.exit(1);
}
