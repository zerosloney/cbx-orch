import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

interface NotificationConfig { webhook?: string; }
interface TelemetryConfig { enabled?: boolean; endpoint?: string; serviceName?: string; }
interface ObservabilityConfig { notifications?: NotificationConfig; telemetry?: TelemetryConfig; }

function isoNow(): string { return new Date().toISOString(); }
function id(bytes = 16): string { return randomBytes(bytes).toString("hex"); }
async function config(workspace: string): Promise<ObservabilityConfig> {
  try { return JSON.parse(await readFile(path.join(workspace, ".cbx.json"), "utf8")) as ObservabilityConfig; }
  catch { return {}; }
}
async function append(workspace: string, file: string, value: unknown): Promise<void> {
  const directory = path.join(workspace, ".cbx");
  await mkdir(directory, { recursive: true });
  await appendFile(path.join(directory, file), JSON.stringify(value, null, 0) + "\n", "utf8");
}

const eventChains = new Map<string, Promise<void>>();

export async function publishEvent(workspace: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const event = { id: id(12), type, at: isoNow(), workspace, payload };
  const previous = eventChains.get(workspace) ?? Promise.resolve();
  const currentTask = previous.catch(() => undefined).then(async () => {
    await append(workspace, "events.ndjson", event);
    const current = await config(workspace);
    if (current.notifications?.webhook) {
      try {
        await fetch(current.notifications.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
      } catch { /* notifications must not break the task */ }
    }
  });
  eventChains.set(workspace, currentTask);
  try { await currentTask; }
  finally { if (eventChains.get(workspace) === currentTask) eventChains.delete(workspace); }
}

export interface SpanHandle { traceId: string; spanId: string; name: string; startedAt: number; attributes: Record<string, string | number | boolean>; }
export function startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): SpanHandle {
  return { traceId: id(16), spanId: id(8), name, startedAt: Date.now(), attributes };
}

export async function finishSpan(workspace: string, span: SpanHandle, status: string, attributes: Record<string, string | number | boolean> = {}): Promise<void> {
  const endedAt = Date.now();
  const spanRecord = { traceId: span.traceId, spanId: span.spanId, name: span.name, startedAt: span.startedAt, endedAt, durationMs: endedAt - span.startedAt, status, attributes: { ...span.attributes, ...attributes } };
  await append(workspace, "telemetry.ndjson", spanRecord);
  const current = await config(workspace);
  if (!current.telemetry?.enabled || !current.telemetry.endpoint) return;
  const startNs = String(span.startedAt * 1_000_000);
  const endNs = String(endedAt * 1_000_000);
  const attributesList = Object.entries(spanRecord.attributes).map(([key, value]) => ({ key, value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { intValue: String(value) } : { stringValue: String(value) } }));
  const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: current.telemetry.serviceName ?? "cbx-orchestrator" } }] }, scopeSpans: [{ spans: [{ traceId: span.traceId, spanId: span.spanId, name: span.name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: attributesList, status: { code: status === "ok" ? 1 : 2 } }] }] }] };
  try { await fetch(current.telemetry.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); }
  catch { /* telemetry must not break the task */ }
}
