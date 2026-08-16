import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/**
 * 本地 HTTP 服务的共享请求守卫：防 DNS rebinding 与跨站（CSRF）请求。
 *
 * 威胁模型：ui / mcp --http 绑定回环且默认无 token。回环不是浏览器安全边界——
 * 任意网页可用 no-preflight 的 simple request（text/plain POST）直接调用写接口；
 * 恶意域名解析到 127.0.0.1（DNS rebinding）可把请求伪装成同源读取响应。
 *
 * 两道防线：
 * - Host 头必须是回环主机名（防 rebinding：rebinding 场景下 Host 是攻击者域名）。
 * - Origin 头存在时（浏览器跨站请求必带）必须指向回环；非浏览器客户端通常不发送
 *   Origin，不受影响。`Origin: null`（沙箱 iframe 等）按跨站拒绝。
 */

/** Host 头（可带 :port）是否指向本机回环。 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTNAMES.has(bare);
}

/** Origin 头是否与回环服务同源。无 Origin（非浏览器客户端）放行。 */
export function isSameLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const value = origin.trim().toLowerCase();
  if (!value || value === "null") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** 请求是否携带 body（content-length > 0 或 chunked）。 */
export function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const raw = req.headers["content-length"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const length = Number(header);
  return Number.isFinite(length) && length > 0;
}

/** content-type 是否为 application/json（带 charset 等后缀也接受）。 */
export function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return value.trim().toLowerCase().startsWith("application/json");
}

/** 组合守卫：Host 回环 + Origin（若存在）同源回环。违反即 403。 */
export function isTrustedLocalRequest(req: IncomingMessage): boolean {
  return (
    isLoopbackHostHeader(req.headers.host) &&
    isSameLoopbackOrigin(req.headers.origin)
  );
}
