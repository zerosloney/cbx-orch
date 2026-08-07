# LongHorizon-Harness 对照验证：Seam 分析

日期：2026-08-07

## 背景

对照 [AMAP-ML/LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness) v0.1.2，评估 cbx-orch 是否需要吸收以下两个 seam：

1. **Role/executor 数据驱动配置** — 按角色独立配置 agent 后端和模型
2. **Environment/workspace 抽象接口** — 统一本地、隔离 worktree 和未来容器执行

判断标准：YAGNI 阶梯。若现有抽象已覆盖真实需求，记录"不新增抽象"结论。

---

## Seam 1：Role/executor 数据驱动配置

### LongHorizon-Harness 做法

- `config.toml` 中为每个角色（manager/executor/auditor/gui_executor/cli_executor）独立配置 `agent` 和 `model`
- 所有 Agent 后端通过 `AgentAdapter` 抽象基类统一接口
- 启动时按角色绑定 adapter，主循环只关心状态转换，不关心 adapter 差异

### cbx-orch 当前实现

- **执行器注册表** `src/executors/builtin.ts`：4 个内置执行器（codebuddy/opencode/omp/cline），通过 `BuiltinExecutor` 接口统一调用契约
- **插件系统** `src/executor.ts`：`ExecutorRequest`/`ExecutorResult` 接口，支持外部 .mjs 插件
- **角色独立覆盖**：
  - `executor` — 全局执行器
  - `reviewExecutor` — 审查执行器（`runStage` 中传参，per-stage 可覆盖）
  - `adaptive.managerExecutor` — Adaptive Manager 执行器
  - `taskContract.stages[].executor` — per-stage 执行器
  - `taskContract.stages[].reviewExecutor` — per-stage 审查执行器
- **调用路径**：`invokeExecutor()` → `resolveExecutor()` 查内置注册表 → 未命中则按插件路径加载

### YAGNI 阶梯

| 阶梯 | 结论 |
|------|------|
| 1️⃣ 这东西真的需要存在？ | 不需要。当前每个角色已可独立指定执行器。 |
| 2️⃣ 代码库里已经有了？ | 已有。`executor`/`reviewExecutor`/`adaptive.managerExecutor` 覆盖了所有角色差异。 |
| 3️⃣ 标准库能搞定？ | N/A |
| 4️⃣ 原生平台功能覆盖了？ | 已有 `ExecutorRequest`/`ExecutorResult` 契约，与 LH 的 `AgentAdapter` 等价。 |
| 5️⃣ 已安装的依赖能解决？ | N/A |
| 6️⃣ 一行能可读地解决？ | N/A |
| 7️⃣ 以上都不行时 → 写最少的工作代码 | 不需要。 |

### 判定：不新增抽象

**理由：**

1. **现有能力已覆盖所有角色差异路径。** `reviewExecutor` 和 `managerExecutor` 的存在证明 cbx-orch 在设计上已经考虑了角色独立绑定。新增一个数据驱动配置表只是把已有的 `executor`/`reviewExecutor`/`adaptive.managerExecutor` 三个字段搬进一个 `[role]` 嵌套对象，是横向移动而非能力缺口。

2. **`ExecutorRequest`/`ExecutorResult` 契约已等价于 `AgentAdapter`。** LH 的 `AgentAdapter` 是 Python 抽象基类，cbx-orch 的 `ExecutorPlugin` 接口（`run(request): Promise<ExecutorResult>`）功能相同。增加一层抽象不会让插件写得更好或更差。

3. **cbx-orch 的分支点不在 adapter 层，而在 prompt 层。** 角色差异主要通过 `promptFor()` 和角色专属 context pack 实现，而非 adapter 选择。Adapter 只是 shell 参数的翻译器——所有执行器都接收同样的 prompt + 上下文包。

4. **四类不同的 prompt 构造（manager/executor/auditor/review）才是真正的架构 seam。** 这些已经在 `adaptive-manager.ts`、`core.ts` 和 `context-pack.ts` 中实现。LH 的 `role_prompts.py` 做同样的事，两者没有本质区别。

---

## Seam 2：Environment/workspace 抽象接口

### LongHorizon-Harness 做法

- `Environment` 抽象基类，支持 `local` 和 `remote` 实现
- `RemoteFiles` 提供远程文件操作（`ensure_remote_dir`、`write_remote_text`）
- 配置中 `env = "local"` 选择环境类型

### cbx-orch 当前实现

- **`src/git-ops.ts`**：`prepareWorktree`、`snapshotDiff`、`collectDiff`、`commitWorktree`、`cleanupWorktree`
- **`src/storage.ts`**：SQLite 持久化、队列、文件锁定
- **`src/core.ts`** 中的 `executeJobLocked`：选择 workdir 的逻辑（`prepareWorktree` vs 直接使用 workspace）
- **隔离模式**：`isolated=true` 使用 Git worktree，`isolated=false` 直接在主工作区运行
- **`trustMode: "untrusted"`**：当前被显式拒绝（"未提供 OS 容器沙箱"）

### YAGNI 阶梯

| 阶梯 | 结论 |
|------|------|
| 1️⃣ 这东西真的需要存在？ | 不需要。当前只有本地环境，没有其他实现需求。 |
| 2️⃣ 代码库里已经有了？ | `git-ops.ts` 已把文件系统操作从核心逻辑中分离。 |
| 3️⃣ 标准库能搞定？ | `fs/promises` 已覆盖所有文件操作。 |
| 4️⃣ 原生平台功能覆盖了？ | Git worktree 是合适的隔离机制，没有更好的原生替代。 |
| 5️⃣ 已安装的依赖能解决？ | N/A |
| 6️⃣ 一行能可读地解决？ | N/A |
| 7️⃣ 以上都不行时 → 写最少的工作代码 | 不需要。 |

### 判定：不新增抽象

**理由：**

1. **`git-ops.ts` 已经是环境抽象边界。** 所有与工作区/文件系统/ git 操作相关的逻辑都集中在 `git-ops.ts` 中。`core.ts` 不直接调用 `spawn` 或 `fs` 操作文件系统——它通过 `git-ops` 和 `storage` 访问。这意味着现有抽象已经支持在未来替换实现。

2. **没有第二个环境实现需要统一。** LH 的 `RemoteFiles` 服务于他们的远程执行场景。cbx-orch 的 `untrusted` 模式已被显式拒绝，没有容器或远程执行计划。增加 `Environment` 接口=创建一个只有一个实现的接口。

3. **未来容器支持不需要预先抽象。** 当容器执行成为真实需求时，容器实现自然是 `git-ops.ts` 的替代——到时可以提取接口。YAGNI 要求在需求出现之前不做抽象。

4. **没有调用路径能受益于统一接口。** `prepareWorktree` 只在 `executeJobLocked` 中被调用一次。`commitWorktree` 只在 `finish` 和 `approveJobLocked` 中被调用。这些调用点已经集中，未来替换成本很低。

---

## 总体结论

### 不吸收的 seam

| 项目 | seam | 结论 |
|------|------|------|
| 1 | 角色独立 agent 配置 | 不新增抽象。`executor`/`reviewExecutor`/`managerExecutor` 已覆盖。 |
| 2 | 环境抽象接口 | 不新增抽象。`git-ops.ts` 已是充分边界，无第二个实现需求。 |

### 已吸收的 LongHorizon 能力（阶段 1-3）

| 能力 | cbx-orch 对应 |
|------|--------------|
| 结构化审计 | `src/progress.ts` + `core.ts` 中的 `structuredAudit` |
| Verified progress 投影 | `reconcileVerifiedProgress` + `auditAllowsCompletion` |
| 确定性完成门 | `verification_gate` + `completionEvidenceValid` |
| Fresh Context 上下文包 | `src/context-pack.ts` + 角色专属投影 |
| 统一 Human Gate | `src/human-gate.ts` + 6 种 reason |
| Adaptive Manager | `src/adaptive-manager.ts` + `requestAdaptiveAction` |
| 审批队列 | `approvalBeforeRun` + `approvalBeforeComplete` + `savePersistedStateAndResolveApprovalQueue` |
| 重复失败检测 | `trackFailure` + `repeated_failure` gate |

### 明确未吸收项及原因

| 项 | 原因 |
|----|------|
| GUI/CLI 子角色分离 | cbx-orch 的 `taskContract.stages` 已允许任意细粒度分阶段，不需要 LH 的 gui/cli 子角色概念 |
| TOML 配置格式 | .cbx.json（JSON）已覆盖，且更简单 |
| AgentAdapter 抽象基类 | `ExecutorPlugin` 接口等价，不需要另一层封装 |
| RemoteFiles / 远程环境 | cbx-orch 不运行远程执行，`untrusted` 模式已被拒绝 |
| 仪表盘实时角色状态 | cbx-orch 的 Web UI 有不同设计（`ui.ts`），不重叠 |
| 多语言 prompt 模板 | cbx-orch 的 prompt 是中文，面向单一语言用户 |

---

## 如果未来需要

如果未来出现以下情况，应重新考虑：

- **容器执行需求**：提取 `src/git-ops.ts` 中的接口为 `ExecutionEnvironment` 抽象，容器实现直接替换
- **第三方执行器数量超过 6 个**：考虑将 `builtin.ts` 注册表改为外部配置驱动（JSON/YAML 文件）
- **远程执行需求**：`savePersistedStateAndResolveApprovalQueue` 等持久化接口已适用于远程，但需要新的文件传输层