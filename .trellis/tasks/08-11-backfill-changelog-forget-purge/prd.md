# 补 CHANGELOG 缺失的 forget/purge 条目

## Goal

把已提交但未记录进 `CHANGELOG.md` 的 forget/purge 功能补入 Unreleased 区，对齐仓库「用户可见行为变更需记录」的变更规范。功能代码已全部落地提交（CLI/MCP/TUI/UI 四层 + 保留策略重构），本任务只补文档，不改代码。

## Background / Confirmed Facts

- 相关提交（均已在 master，未进 CHANGELOG）：
  - `034a906` feat(cli): `cbx forget` / `cbx purge`
  - `04cf649` feat(state): `forgetJob` / `purgeJob` 生命周期原语
  - `c5d65f8` refactor(state): 保留期清理收敛到 `pruneAfterTerminal`
  - `d18efa5` feat(mcp): `cbx_forget` / `cbx_purge` 工具
  - `2ed37e1` feat(tui): `d` / `D` 两步确认
  - `80dc0b9` feat(ui): `POST /api/jobs/:id/forget|purge` + 按钮
- 当前 `CHANGELOG.md` Unreleased 已含 workspace discovery 条目（上一任务），forget/purge 缺失。
- 现有 Unreleased 条目风格：`- Feature: …` / `- Refactor: …` / `- Test: …`，中文，末尾注测试总数（当前 462）。

## Requirements

- R1. 在 `CHANGELOG.md` Unreleased 区补 forget/purge 相关条目，覆盖：
  - Feature: `cbx forget <jobId> [--reason <text>] [--yes]`（保留 worktree；删 `state.json`/`events.ndjson`/所有 artifact；写 tombstone 到 metadata，防同 id 重建静默继承孤儿状态）与 `cbx purge`（连 worktree 一起删）；`--reason` 落审计轨迹。
  - Feature: MCP `cbx_forget` / `cbx_purge` 工具（复用同一 state 原语，无第二条删除路径；分开而非单一 `cbx_forget{purge_worktree}`，便于 schema 选择与审计区分）。
  - Feature: TUI `d`（forget）/ `D`（purge）两步确认（破坏性不可逆操作需二次按键）。
  - Feature: Web UI `POST /api/jobs/:id/forget|purge` 路由 + 详情面板按钮。
  - Refactor: 保留期清理收敛到 `pruneAfterTerminal`，消除各终态调用点重复的 retentionDays 解析/prune 调用。
- R2. 风格与现有条目一致（中文、`- Feature:`/`- Refactor:` 前缀、简洁、说明行为与边界）。
- R3. 不改任何代码/测试，仅编辑 `CHANGELOG.md`。

## Acceptance Criteria

- [ ] AC1. `CHANGELOG.md` Unreleased 区出现 forget/purge 条目，覆盖上述 Feature + Refactor 内容。
- [ ] AC2. 条目描述与提交行为一致（tombstone、--reason 审计、两条删除路径、两步确认、POST 路由、pruneAfterTerminal 收敛）。
- [ ] AC3. 除 `CHANGELOG.md` 外无任何文件改动（`git diff` 仅此一文件）。
- [ ] AC4. 改动已提交。

## Out of Scope

- 不改代码、不补测试（功能已提交且有测试覆盖）。
- 不重排 CHANGELOG 既有条目。
