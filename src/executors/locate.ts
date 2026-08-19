import { access } from "node:fs/promises";
import path from "node:path";

// 二进制定位的唯一实现：PATH×PATHEXT 展开 + 逐候选探测。
// 探测（cbx agents 的可用性检查）与 spawn（findExecutable）共用同一算法，
// 避免「探测说可用、spawn 找不到」的口径漂移。

/** 裸二进制名 → PATH×PATHEXT 展开的候选路径列表；带路径分隔符的名字原样返回。 */
export function expandPathCandidates(name: string): string[] {
  const isPathLike = name.includes("/") || name.includes("\\") || path.isAbsolute(name);
  if (isPathLike) return [name];
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
      : [""];
  return pathDirs.flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext)));
}

/** 返回第一个真实存在的候选路径；全部未命中返回 null。 */
export async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null;
}

/** 依次沿 PATH 探测候选二进制名，返回第一个命中的路径；不含 envVar 覆盖逻辑（由调用方处理）。 */
export async function locateOnPath(names: string[]): Promise<string | null> {
  for (const name of names) {
    const found = await firstExisting(expandPathCandidates(name));
    if (found) return found;
  }
  return null;
}
