# Design: Webhook 事件订阅细分

## 1. Scope & Trigger

- 触发：webhook 当前全量推送 `job.state_changed` 事件，无过滤能力。
- 边界：`src/observability.ts`（投递点）+ `src/storage.ts`（config schema）。不触碰 delivery outbox 的投递/重试机制——过滤发生在 enqueue 之前，outbox 无感知。
- 单任务，无子项拆分。

## 2. Contracts

### 2.1 Config Schema 扩展（`src/storage.ts`）

```typescript
// RuntimeConfig.notifications 扩展
interface NotificationFilters {
  events?: string[];    // 事件 type 白名单
  jobIds?: string[];    // payload.jobId 白名单
  statuses?: string[];  // payload.status 白名单
}
interface NotificationConfig extends DeliveryConfig {
  webhook?: string;
  filters?: NotificationFilters;
}
```

**strict schema 校验**（`loadRuntimeConfig` 的 notifications 分支）：
- `known(value, "notifications", [...现有..., "filters"])` 加 `filters`
- `filters` 为对象；`known(filters, "notifications.filters", ["events", "jobIds", "statuses"])`（未知键拒绝）
- 每个数组可选，但若存在必须是非空字符串数组

**兼容性**：`webhook` 保持字符串；无 `filters` 时行为不变。**注意**：现有 `known(notifications, [...])` 白名单需加 `filters`，否则带 filters 的配置会被拒绝（strict schema 的既有行为）。

### 2.2 过滤纯函数（`src/observability.ts`）

```typescript
export function matchesWebhookFilters(
  event: { type: string; payload: Record<string, unknown> },
  filters: NotificationFilters | undefined,
): boolean {
  if (!filters) return true;                              // 无配置 → 全量
  if (filters.events && !filters.events.includes(event.type)) return false;
  const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
  if (filters.jobIds && (!jobId || !filters.jobIds.includes(jobId))) return false;
  const status = typeof event.payload.status === "string" ? event.payload.status : undefined;
  if (filters.statuses && (!status || !filters.statuses.includes(status))) return false;
  return true;                                            // AND 语义
}
```

- 导出供单测；AND 语义（多条件同时满足）。
- 字段缺失：`jobId`/`status` 非字符串时该维度不匹配（若配置了该维度过滤）。

### 2.3 投递点接入（`src/observability.ts` `publishEvent`）

```typescript
if (current.notifications?.webhook) {
  const notifications = current.notifications;
  if (matchesWebhookFilters({ type, payload }, notifications.filters)) {
    await enqueueDelivery(workspace, { channel: "webhook", endpoint: notifications.webhook, body: redacted, config: notifications });
    scheduleDeliveryDrain(workspace);
  }
}
```

过滤不匹配 → 不 enqueue、不落 delivery 记录、不调度 drain。本地 `events.ndjson` 仍全量记录（`append` 在过滤前执行，与过滤无关）。

## 3. Data Flow

```
publishEvent(type, payload)
  ├→ nextEventSeq + redact + append events.ndjson（全量，不受过滤影响）
  ├→ 有 webhook？
  │    ├→ matchesWebhookFilters({type, payload}, notifications.filters)?
  │    │     ├→ true  → enqueueDelivery + scheduleDeliveryDrain
  │    │     └→ false → 跳过（不投递）
  │    └→ 无 webhook → 跳过
```

## 4. Tradeoffs

| 决策 | 选项 | 选择 |
|------|------|------|
| 过滤位置 | enqueue 前 vs outbox drain 时 | enqueue 前（outbox 只存应投递的事件，避免死信/重试浪费） |
| filters 形态 | 独立字段 vs webhook 对象内 | `notifications.filters`（webhook 保持字符串，避免破坏现有 `webhook` 单字符串契约） |
| 事件粒度 | 仅 job.state_changed vs 所有 type | 通用 `events` 数组（任意事件 type 可过滤，未来扩展） |

## 5. Compatibility

- 无 `filters` 配置 → 全量推送（零行为变化）。
- `webhook` 字符串契约不变。
- 新增 `filters` 到 notifications 白名单后，**旧版本 cbx 读取含 filters 的配置会拒绝**——与 templates 相同的 strict schema 已知行为（已在 backend spec checklist #7 记录）。回滚 = 移除 filters 字段。

## 6. Rollback

- 单文件 revert（`observability.ts` + `storage.ts`）即可。
- 配置兼容：回滚后需从 `.cbx.json` 移除 `filters` 字段。

## 7. Test Strategy

- `matchesWebhookFilters` 单测（`tests/reliability.test.ts` 或新文件）：
  - 无 filters → true
  - events 匹配/不匹配
  - jobIds 匹配/不匹配/缺失
  - statuses 匹配/不匹配/缺失
  - 多条件 AND
- config schema（`tests/core.executor.test.ts`）：filters 合法接受 / 未知键拒绝 / 数组元素类型错误拒绝
- 集成：publishEvent 带 filters 不匹配时无 delivery 记录（查 `nextPendingDeliveryAt` 或 outbox 计数）
