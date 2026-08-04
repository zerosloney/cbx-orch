import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadRuntimeConfig, recordDeliveryFailure, redactSensitive } from "./storage.js";
function isoNow() { return new Date().toISOString(); }
function id(bytes = 16) { return randomBytes(bytes).toString("hex"); }
async function config(workspace) {
    return loadRuntimeConfig(workspace);
}
async function append(workspace, file, value) {
    const directory = path.join(workspace, ".cbx");
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, file), JSON.stringify(value, null, 0) + "\n", "utf8");
}
function deliveryOptions(config) {
    const timeoutMs = config.timeoutMs ?? 3_000;
    const maxRetries = config.maxRetries ?? 2;
    const retryBaseMs = config.retryBaseMs ?? 100;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 50)
        throw new Error("通知 timeoutMs 必须不小于 50ms。");
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
        throw new Error("通知 maxRetries 必须是 0 到 10 的整数。");
    if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0)
        throw new Error("通知 retryBaseMs 必须是非负数。");
    return { timeoutMs, maxRetries, retryBaseMs };
}
async function deliver(workspace, channel, endpoint, body, deliveryConfig) {
    const options = deliveryOptions(deliveryConfig);
    let lastError = "";
    for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
        try {
            const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return;
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt < options.maxRetries)
                await new Promise(resolve => setTimeout(resolve, options.retryBaseMs * 2 ** attempt));
        }
        finally {
            clearTimeout(timeout);
        }
    }
    const runtime = await config(workspace);
    const failure = redactSensitive({ type: "delivery.failed", at: isoNow(), channel, endpoint, attempts: options.maxRetries + 1, error: lastError, body }, runtime.governance?.redactFields);
    await append(workspace, "delivery-failures.ndjson", failure);
    await recordDeliveryFailure(workspace, failure);
    console.error(`cbx: ${channel} 投递失败（已重试 ${options.maxRetries} 次）：${lastError}`);
}
const eventChains = new Map();
export async function publishEvent(workspace, type, payload) {
    const event = { id: id(12), type, at: isoNow(), workspace, payload };
    const previous = eventChains.get(workspace) ?? Promise.resolve();
    const currentTask = previous.catch(() => undefined).then(async () => {
        const current = await config(workspace);
        const redacted = redactSensitive(event, current.governance?.redactFields);
        await append(workspace, "events.ndjson", redacted);
        if (current.notifications?.webhook) {
            await deliver(workspace, "webhook", current.notifications.webhook, redacted, current.notifications);
        }
    });
    eventChains.set(workspace, currentTask);
    try {
        await currentTask;
    }
    finally {
        if (eventChains.get(workspace) === currentTask)
            eventChains.delete(workspace);
    }
}
export function startSpan(name, attributes = {}) {
    return { traceId: id(16), spanId: id(8), name, startedAt: Date.now(), attributes };
}
export async function finishSpan(workspace, span, status, attributes = {}) {
    const endedAt = Date.now();
    const spanRecord = { traceId: span.traceId, spanId: span.spanId, name: span.name, startedAt: span.startedAt, endedAt, durationMs: endedAt - span.startedAt, status, attributes: { ...span.attributes, ...attributes } };
    await append(workspace, "telemetry.ndjson", spanRecord);
    const current = await config(workspace);
    if (!current.telemetry?.enabled || !current.telemetry.endpoint)
        return;
    const startNs = String(span.startedAt * 1_000_000);
    const endNs = String(endedAt * 1_000_000);
    const attributesList = Object.entries(spanRecord.attributes).map(([key, value]) => ({ key, value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { intValue: String(value) } : { stringValue: String(value) } }));
    const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: current.telemetry.serviceName ?? "cbx-orchestrator" } }] }, scopeSpans: [{ spans: [{ traceId: span.traceId, spanId: span.spanId, name: span.name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: attributesList, status: { code: status === "ok" ? 1 : 2 } }] }] }] };
    await deliver(workspace, "otlp", current.telemetry.endpoint, payload, current.telemetry);
}
