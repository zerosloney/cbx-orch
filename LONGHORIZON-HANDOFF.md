# LongHorizon-Harness 改进实施交接

更新时间：2026-08-07（Asia/Shanghai）

## 目标

继续完成将 [AMAP-ML/LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness) 中最有价值的长期任务编排能力吸收到本项目的工作，并严格遵守“每阶段实现 → 主审 → 有问题返修 → 通过后进入下一阶段”的顺序。

工作区：E:\Demo\cli-tools\cbx-orch

## 工作区保护事项

- README.md 在本轮开始前已有用户自己的未提交改动。不要编辑、格式化、还原或提交它。
- 当前所有实现均未 commit；用户没有要求 commit。
- 当前 diff 较大是前三阶段累计结果。使用 git diff -- . ':(exclude)README.md' 查看任务改动。
- .codegraph/ 不存在；此前已提示过用户，不要擅自初始化。
- 用户已经明确授权按阶段实施这份跨文件方案，无需为同一范围重复触发 AGENTS.md 的 STOP 确认；若进一步扩大公共契约、引入依赖、迁移数据或删除既有代码，仍需重新确认。

## 阶段状态

### 阶段 1：Structured Audit + Verified Progress — 已通过

实现集中在 src/progress.ts、src/core.ts、tests/core.test.ts。

已实现结构化审计、稳定 criterion ID、证据 SHA、verified progress 投影和确定性完成门。曾发现并修复静态 skipReview 回归及旧 verified progress 被错误复用的问题。主审时完整测试为 96/96 通过。

### 阶段 2：Opt-in Adaptive Manager — 已通过

实现集中在 src/adaptive-manager.ts、src/core.ts、src/storage.ts、src/cli.ts、src/mcp-server.ts 及对应测试。

已实现默认关闭的 adaptive 配置、严格 NextAction、累计轮次、manager workspace 安全检查、CLI/MCP 参数和持久化。曾修复 dormant skipReview 绕过完成门及 adaptive needs_fix 清理 worktree 的问题。主审最终完整测试为 106/106 通过。

### 阶段 3：Fresh Context + Unified Human Gate — 修复中，未通过

初版已新增：

- src/context-pack.ts
- src/human-gate.ts
- approval.beforeComplete
- CLI/MCP 的 approval_before_complete、extra_rounds
- before-run、needs-input、semantic-conflict、repeated-failure、max-rounds、completion 等统一 Human Gate
- 完成前审批的 evidence hash + worktree digest 冻结与 stale 拒绝

初版主审确认了以下阻塞项：

1. verifiedProgress / audit 原样进入 context pack，绕过 governance redaction。
2. executor/auditor prompt 仍直接要求读取 context.json，且 raw review rules / criteria 可绕过 context pack。
3. 后台完成审批后，原 queue entry 会永久停在 awaiting_approval。
4. 完成审批后 autoCommit 失败会清理唯一 worktree，存在数据丢失风险。
5. verification_gate 被排除在重复失败统计之外，第三次同因失败不会进入 repeated_failure gate。

这些问题已交回 luna-worker，但用户要求交接时 luna-worker 被中断，当前是“部分修复、专项测试未补完”的中间态。

当前源码中已经出现的部分修正：

- src/context-pack.ts 已增加 progress/audit 的有界类型化投影和字符串脱敏，并把 auditor criterion ID 映射放入 pack。
- 有 context pack 时，src/core.ts 的 promptFor 已改为只直接引用 pack；角色只能按 pack 中的 artifact 白名单读取材料。
- src/storage.ts 的 savePersistedStateAndResolveApprovalQueue 与 src/core.ts 的 writeApprovalState 已用于收敛审批队列项。
- approveJobLocked 的 commit 失败分支已不再清理 worktree。
- verification_gate 已从 failure-tracker 排除表中移除。

不要把这些视为已验收：配套测试还没有完整补齐，现有测试也有一项需要按新语义更新。

## 当前验证结果

- npm run lint：通过。
- git diff --check：通过。
- npm test：109/110 通过，1 项失败。
- 失败测试：context snapshot is persisted and required by implementation and review prompts（tests/core.test.ts 约 1119 行）。旧断言要求 context-snapshot.md 在 impl/review prompt 中直接出现；新设计应让 prompt 只引用 context pack，并由 pack 的 artifacts 引用 snapshot，因此应更新测试验证新边界，而不是恢复旧行为。

## 下一步实施顺序

### 3A. 完成阶段 3 修复与回归

先读取当前相关完整符号和 diff，再做最小修改。必须补齐以下可运行检查：

1. Context Pack 脱敏：让 acceptance criterion 本身含测试敏感串，确保 audit/progress 已生成后 manager/executor/auditor 三个 pack 和捕获到的 prompts 都不含该串；三个 pack 均不超过 24K，严格 parser 拒绝未知/畸形结构。
2. Fresh Context：更新失败的 context-snapshot 测试，断言 prompt 不含 context.json、不直接含 snapshot 路径；对应 role pack 的 artifact 引用必须包含 snapshot 的绝对路径和 SHA。
3. 审批队列：新增后台 before_complete → approve 测试，断言 JobState 为 done，原 queue entry 也为 done，没有遗留 awaiting_approval。同时扩展 before-run 后台审批测试，确认旧 awaiting entry 被正确收敛且任务仍能继续。
4. 提交失败保留 worktree：用稳定方式触发 commitWorktree 失败，断言状态为 failed/git_commit，worktree 和已验证修改仍存在，且 queue entry 不悬挂。
5. verification 重复失败：构造同一 verification_gate 连续三次，第三次必须得到 humanGate.reason === repeated_failure 且状态 waiting。

完成后依次运行 npm run lint、相关 node --test 定向测试、npm test、git diff --check。

若全部通过，再按 review-verification-protocol 重新核对以上五项；只复审本轮既有发现，不在返修复审时引入新的风格型问题。

### 3B. 阶段 3 通过后再进入阶段 4

阶段 4 不是直接编码。先做 LongHorizon-Harness 对照验证，决定本项目是否还需要吸收以下两个 seam：

- role/executor 配置是否应进一步数据驱动，而不是继续增加分支；
- environment/workspace 能力是否需要更深接口，以统一本地工作区、隔离 worktree 和未来容器执行。

按 YAGNI 阶梯判断：若现有 adaptive-manager.ts、executor registry 和 git/worktree helper 已覆盖真实需求，记录“不新增抽象”的结论；只有能给出当前调用路径、明确收益和可运行验收时才实施。若实施，仍按“实现工具完成 → 主审 → 返修 → 通过”单阶段推进。

### 阶段 5：最终总审与交付

- 检查全部任务 diff，排除 README 和无关改动。
- 完整运行 lint/test/diff-check。
- 核对默认关闭和向后兼容：无 task contract、静态 skipReview、普通非 adaptive、before-run approval、CLI/MCP 旧调用。
- 汇总实际吸收的 LongHorizon 能力、明确未吸收项及原因。
- 未经用户明确要求不要 commit、stage 或 push。

## 建议 skills

- diagnosing-bugs：先处理当前唯一失败测试，并区分旧断言与真实回归。
- codebase-design：阶段 4 判断 role/environment seam 是否值得存在。
- code-review：每个阶段实现完成后做 Standards / Spec 双轴审查。
- review-verification-protocol：报告任何审查发现前必须逐项完成 anchor、evidence、severity、format 验证。

## 推荐接手起点

1. git status --short
2. git diff --check
3. 阅读 src/context-pack.ts 全文件。
4. 阅读 src/core.ts 中 promptFor、runStage、finish、prepareContinuationUnlocked、approveJobLocked、startBackground 的完整符号。
5. 阅读 src/storage.ts 的 savePersistedStateAndResolveApprovalQueue 及其调用。
6. 阅读 tests/core.test.ts 中 context pack、approval、repeated failure、context snapshot 测试，再补上述专项回归。

