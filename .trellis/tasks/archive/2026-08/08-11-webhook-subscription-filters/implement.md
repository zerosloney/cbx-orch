# Implement: Webhook 事件订阅细分

## 执行顺序

单功能，按 1 → 2 → 3 顺序，每步验证后进入下一步。

---

## Step 1: Config schema（`src/storage.ts`）

**改动**：
1. `RuntimeConfig` 的 notifications 类型加 `filters`（定义 `NotificationFilters` interface）。
2. `loadRuntimeConfig` notifications 分支：
   - `known` 白名单（L222）加 `"filters"`
   - 校验 `filters`：对象、未知键拒绝、各数组非空字符串数组

```typescript
// notifications 分支内，webhook/timeoutMs 校验后
if (value.filters !== undefined) {
  const filters = object(value.filters, "notifications.filters");
  known(filters, "notifications.filters", ["events", "jobIds", "statuses"]);
  for (const key of ["events", "jobIds", "statuses"] as const) {
    if (filters[key] !== undefined && (!Array.isArray(filters[key]) || filters[key].length < 1 || filters[key].some(item => typeof item !== "string" || !item.trim())))
      throw new Error(`notifications.filters.${key} 必须是非空字符串数组。`);
  }
}
```

**验证**：
```bash
npm run build
node --test dist/tests/core.executor.test.js   # 新增 filters schema 测试
```

---

## Step 2: 过滤纯函数 + 投递点（`src/observability.ts`）

**改动**：
1. 定义并导出 `matchesWebhookFilters`（见 design.md 2.2）。
2. `publishEvent` 的 webhook 分支接入过滤（见 design.md 2.3）。

**验证**：
```bash
npm run build
node --test dist/tests/reliability.test.js     # 新增 matchesWebhookFilters 单测
```

---

## Step 3: 集成测试 + README

**改动**：
- `README.md` notifications 配置示例加 `filters`。
- 集成测试：publishEvent 带 filters 不匹配 → outbox 无 delivery（`nextPendingDeliveryAt` 为 undefined 或计数 0）；匹配 → 有 delivery。

**验证**：
```bash
npm run build
node --test dist/tests/reliability.test.js dist/tests/core.executor.test.js
```

---

## 全量验证（Step 3 后）

```bash
npm run lint
npm test
npx prettier --check <改动文件>
git diff --check
```

## 回滚点

| 步骤 | 回滚 |
|------|------|
| 全部 | revert `src/observability.ts` + `src/storage.ts` + README |
| 配置兼容 | 回滚后需从 `.cbx.json` 移除 `filters`（旧版本 strict schema 会拒绝未知字段） |

## Review Gate

- `matchesWebhookFilters` AND 语义正确，字段缺失不误投递
- filters schema：未知键/空数组/错类型均拒绝
- 过滤不匹配不产生 delivery 记录（本地 events.ndjson 不受影响）
- 无 filters 时零行为变化
