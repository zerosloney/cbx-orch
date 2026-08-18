import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

// 依赖守卫的受监控清单：覆盖主流语言生态的依赖声明 + 锁文件。
// executor（codebuddy/opencode 等）是多语言通用编码 CLI，仅覆盖 JS 会让 Go/Rust/Python 项目裸奔。
const DEP_FILES = [
  // JS / Node
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  // Python
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile.lock",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Go
  "go.mod",
  "go.sum",
  // Ruby
  "Gemfile",
  "Gemfile.lock",
  // Java / JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

export async function collectDepBaseline(
  workdir: string,
): Promise<Record<string, string>> {
  const baseline: Record<string, string> = {};
  for (const file of DEP_FILES) {
    const fullPath = path.join(workdir, file);
    if (existsSync(fullPath)) {
      baseline[file] = createHash("sha256")
        .update(await readFile(fullPath))
        .digest("hex");
    }
  }
  return baseline;
}

export async function detectChangedDeps(
  workdir: string,
  baseline: Record<string, string>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of DEP_FILES) {
    const fullPath = path.join(workdir, file);
    if (existsSync(fullPath) && baseline[file]) {
      const currentHash = createHash("sha256")
        .update(await readFile(fullPath))
        .digest("hex");
      if (currentHash !== baseline[file]) changed.push(file);
    }
  }
  return changed;
}
