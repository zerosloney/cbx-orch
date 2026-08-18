/** 敏感信息脱敏：对对象树做键名匹配，命中则替换值为 [REDACTED]。 */
export function redactSensitive(
  value: unknown,
  fields: readonly string[] = [],
): unknown {
  const sensitive = new Set(fields.map((field) => field.toLowerCase()));
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [
        key,
        sensitive.has(key.toLowerCase()) ? "[REDACTED]" : visit(child),
      ]),
    );
  };
  return visit(value);
}

// intentional-simple: 行级键名匹配用单一正则覆盖 `key: v` / `- key: v` / `key = v` 三种形态。
// 抓不到句中内嵌密钥（如 "use sk-xxx here"）；由 redactPatterns 全文正则兜底。
const KEY_LINE =
  /^\s*([-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_\s-]*?)\s*[:=]\s*(.+)$/u;

/** 文本脱敏：先按行匹配键名，再用 patterns 全文正则兜底。 */
export function redactText(
  text: string,
  fields: readonly string[] = [],
  patterns: readonly string[] = [],
): string {
  const sensitive = new Set(fields.map((field) => field.toLowerCase()));
  let out = text;
  if (sensitive.size > 0) {
    out = text
      .split("\n")
      .map((line) => {
        const match = line.match(KEY_LINE);
        if (!match) return line;
        const key = match[2].trim().toLowerCase();
        return sensitive.has(key)
          ? `${match[1] ?? ""}${match[2].trim()}: [REDACTED]`
          : line;
      })
      .join("\n");
  }
  for (const pattern of patterns)
    out = out.replace(new RegExp(pattern, "g"), "[REDACTED]");
  return out;
}
