/**
 * 统一审查判定解析：stage review（fail-closed）与 stop-gate（fail-open）共用同一解析实现，
 * 避免两处各自解析 review.md 首行导致口径漂移。
 *
 * 判定来源优先级：
 * 1. review.json（结构化）：`{"version":1,"verdict":"PASS"|"FAIL"}`，机器可读，不受首行格式影响；
 * 2. review.md 首行 `VERDICT: PASS|FAIL`（旧契约，供未写 review.json 的审查器向后兼容）；
 * 3. 均无法解析 → UNKNOWN（由调用方决定策略：stage 按失败返工，stop-gate 放行并记录）。
 */

export interface ReviewJsonVerdict {
  version: 1;
  verdict: "PASS" | "FAIL";
}

export type ParsedVerdict = "PASS" | "FAIL" | "UNKNOWN";

/** 严格解析 review.json；任何形状不匹配都返回 undefined（调用方回退首行解析）。 */
export function parseReviewJson(raw: unknown): ReviewJsonVerdict | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return undefined;
  if (value.verdict !== "PASS" && value.verdict !== "FAIL") return undefined;
  return { version: 1, verdict: value.verdict };
}

/** 统一判定解析：结构化优先，首行回退，均失败返回 UNKNOWN。 */
export function parseReviewVerdict(
  reviewMd: string,
  reviewJson?: unknown,
): ParsedVerdict {
  const structured = parseReviewJson(reviewJson);
  if (structured) return structured.verdict;
  const firstLine = (reviewMd ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 1)[0]
    .trim();
  if (/^VERDICT\s*:\s*PASS$/i.test(firstLine)) return "PASS";
  if (/^VERDICT\s*:\s*FAIL$/i.test(firstLine)) return "FAIL";
  return "UNKNOWN";
}
