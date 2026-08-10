# Implement: 低复杂度增量功能

## 执行顺序

按 1 → 2 → 3 顺序，每步完成各自验证点后进入下一步。每步单文件可回滚。

---

## Step 1: TUI 事件流面板

**改动文件**：
- `src/tui/index.ts` — `TuiState` 加 `eventStream: { lines: string[]; offset: number }`；`fetchData` 选中任务时增量拉事件；`draw()` 详情后渲染事件行
- `src/tui/index.ts` imports 加 `readEventsIncremental`

**实现**：
```typescript
// TuiState
eventStream: { lines: string[]; offset: number };

// fetchData 选中分支
if (selectedJob) {
  try {
    const { events, next_offset } = await readEventsIncremental(
      workspace, selectedJob.jobId, state.eventStream.offset,
    );
    if (events.length) {
      const fresh = [...state.eventStream.lines, ...events];
      state.eventStream = { lines: fresh.slice(-5), offset: next_offset };
    } else {
      state.eventStream = { ...state.eventStream, offset: next_offset };
    }
  } catch { /* 静默 */ }
}
```

**渲染**（`draw()` 详情后）：
```typescript
if (state.eventStream.lines.length) {
  console.log("\n" + chalk.bold("事件:"));
  for (const line of state.eventStream.lines) {
    const ev = JSON.parse(line);  // 已由 readEventsIncremental 校验
    console.log(`  ${fmtTime(ev.at)} ${colorizeStatus(String(ev.status ?? ev.event ?? ""))} ${ev.event}`);
  }
}
```

**验证**：
```bash
npm run build
node --test dist/tests/tui.test.js
```
- 新增测试：fetchData 增量拉取（offset 推进 + 上限 5 裁剪 + 无新事件不追加）；渲染含状态转场。

---

## Step 2: 任务模板/预设

**改动文件**：
- `src/storage.ts` — `RuntimeConfig` 加 `templates?: Record<string, TaskTemplate>`；`loadRuntimeConfig` 白名单加 `templates` + 结构校验
- `src/state.ts` — `mergeConfig` 不需改（模板在 CLI 层展开）
- `src/cli.ts` — run 分支加 `--template <name>` 处理

**config 校验**（storage.ts）：
```typescript
if (config.templates !== undefined) {
  const templates = object(config.templates, "templates");
  for (const [name, value] of Object.entries(templates)) {
    const tpl = object(value, `templates.${name}`);
    known(tpl, `templates.${name}`, ["task", "test", "review", "executor", "isolated"]);
    if (typeof tpl.task !== "string" || !tpl.task.trim())
      throw new Error(`templates.${name}.task 必须是必填的非空字符串。`);
    optionalString(tpl.test, `templates.${name}.test`);
    optionalBoolean(tpl.review, `templates.${name}.review`);
    optionalString(tpl.executor, `templates.${name}.executor`);
    optionalBoolean(tpl.isolated, `templates.${name}.isolated`);
  }
}
```

**CLI 展开**（cli.ts run 分支，`const defaults = mergeConfig(...)` 之前）：
```typescript
const templateName = parsed.option("--template");
let templateTask: string | undefined;
let templateDefaults: Partial<typeof fileConfig> = {};
if (templateName) {
  const tpl = fileConfig.templates?.[templateName];
  if (!tpl) {
    const names = Object.keys(fileConfig.templates ?? {});
    throw new Error(`模板不存在：${templateName}${names.length ? `。可用：${names.join(", ")}` : ""}（未配置任何模板）`);
  }
  templateTask = tpl.task;
  templateDefaults = { testCommand: tpl.test, review: tpl.review, executor: tpl.executor, isolated: tpl.isolated };
}
// task 解析：--task > --task-file > 模板 task
let task = parsed.option("--task") ?? (templateTask ? (await readFile(...)) : undefined);
```

**验证**：
```bash
npm run build
node --test dist/tests/hardening.test.js
node --test dist/tests/interfaces.test.js
```
- 新增：config `templates` 接受合法/拒绝非法（缺 task、未知键、错类型）；CLI `--template` 展开 + 不存在报错列出可用 + 命令行 `--task` 覆盖模板。

---

## Step 3: 任务结果导出

**改动文件**：
- `src/cli.ts` — 新子命令 `export` 分支
- `src/formatting.ts` — `renderExportMarkdown(state, result)`（可选，若逻辑放 cli.ts 则不需要）

**实现**（cli.ts）：
```typescript
if (command === "export") {
  const jobId = requireJobId(parsed, command);
  const format = parsed.option("--format", "text");
  if (!["text", "markdown"].includes(format)) throw new Error("--format 必须是 text 或 markdown。");
  const state = await loadState(workspace, jobId);
  let result: Record<string, unknown> | null = null;
  try { result = JSON.parse(await readArtifact(workspace, jobId, "result.json")); }
  catch { /* 无 result.json，输出基本状态 */ }
  const dir = jobDir(workspace, jobId);
  const handback = existsSync(...) ? await readFile(...) : null;  // 或 readArtifact
  print(format === "markdown" ? renderExportMarkdown(state, result, handback) : renderExportText(state, result, handback));
  return;
}
```

text 摘要：`renderJobDetail(state)` 打底 + stage 链（result.stages）+ 验收证据计数 + 错误。
markdown：`# 任务 <id>` + 状态表 + stage 表 + 验收列表 + handback 摘要（截断）。

**验证**：
```bash
npm run build
node --test dist/tests/interfaces.test.js   # CLI 端到端 export
```
- 新增：export text/markdown 输出含状态/stage/验收；job 不存在报错；无 result.json 时输出基本状态。

---

## 全量验证（Step 3 后）

```bash
npm run lint
npm test           # 全量
npx prettier --check <改动文件>
git diff --check
```

## 回滚点

| 步骤 | 回滚 |
|------|------|
| Step 1 | revert `src/tui/index.ts` |
| Step 2 | revert `storage.ts` + `cli.ts`（移除 templates 字段即可，旧配置不受影响） |
| Step 3 | revert `cli.ts`（+ formatting.ts 若有） |

> 注意 Step 2 的配置兼容：含 `templates` 的 `.cbx.json` 被旧版本 cbx 读取会拒绝（unknown field）。回滚 Step 2 时需同时移除配置文件中的 `templates` 字段。

## Review Gate

- TUI 事件流游标正确推进（不重读全量）
- templates strict schema 校验完整（缺 task / 未知键 / 错类型）
- export 对无 result.json 的 job 优雅降级
- 三个测试文件全过
