# PRD: Webhook 事件订阅细分

## Goal

webhook 事件投递支持按条件过滤，避免全事件推送。当前 `notifications.webhook` 收到所有事件（`publishEvent` 中无条件 enqueue）；细分后仅匹配订阅条件的事件投递。

## Acceptance Criteria

### 1. 配置扩展

- [ ] `.cbx.json` `notifications.webhook` 保持字符串（向后兼容），新增可选 `notifications.filters`：
  ```json
  {
    "notifications": {
      "webhook": "https://example.test/cbx-events",
      "filters": {
        "events": ["job.state_changed"],
        "jobIds": ["job-123"],
        "statuses": ["done", "failed"]
      }
    }
  }
  ```
- [ ] strict schema 校验：`filters` 为对象，`events`/`jobIds`/`statuses` 均为可选字符串数组；未知 filters 键拒绝。

### 2. 过滤逻辑

- [ ] `publishEvent` 在 enqueue webhook 前检查 `notifications.filters`：
  - `events` 存在时，事件 `type` 必须匹配
  - `jobIds` 存在时，payload `jobId` 必须匹配
  - `statuses` 存在时，payload `status` 必须匹配
  - 过滤为 AND 语义（多条件同时满足才投递）；未配置的维度不限制
- [ ] 过滤不匹配的事件**不 enqueue、不落 delivery 记录**（本地 events.ndjson 仍全量记录，仅 webhook 投递被过滤）。
- [ ] 无 `filters` 配置时行为不变（全量推送，向后兼容）。

### 3. 过滤函数可测性

- [ ] 过滤判定提取为纯函数（如 `matchesWebhookFilters(event, filters): boolean`），导出供单测。
- [ ] 边界：`jobId`/`status` 缺失时该维度视为不匹配（不误投递）。

## Out of Scope

- OTLP/telemetry 的过滤（仅 webhook）。
- 多 webhook 端点（仍单端点 + 过滤器）。
- 订阅的增删改运行时热更新（配置变更需重启/重读）。

## References

- `src/observability.ts` `publishEvent`（enqueue 点，~L215）
- `src/storage.ts` `loadRuntimeConfig`（strict schema 校验模式）
- `.trellis/spec/backend/index.md` Pre-Development Checklist #7（config 新字段需过 strict schema）
