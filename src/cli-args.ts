/** 统一 CLI 参数解析：位置参数与选项一次解析分离，消除 args[0] 位置依赖与 indexOf 重复扫描的脆弱性。 */

/** 带值选项；布尔开关（--review / --ci / --no-* 等）不在此集合，出现即为 true。 */
const VALUE_OPTIONS = new Set([
  "--workspace", "--workspaces-dir", "--task", "--task-file", "--test", "--job-id", "--queue-entry-id",
  "--timeout-ms", "--max-retries", "--max-turns", "--permission-mode", "--executor", "--review-executor",
  "--commit-message", "--trust-mode", "--adaptive-max-rounds", "--manager-executor", "--message",
  "--priority", "--interval-ms", "--extra-rounds", "--port", "--host", "--ui-token",
]);

export interface CliArgs {
  /** 既非选项也非选项值的参数，按出现顺序（如 jobId、queue 子命令）。 */
  positionals: string[];
  /** 选项首个值（与旧 indexOf 语义一致）；未出现返回 fallback。 */
  option(name: string, fallback?: string): string | undefined;
  /** 可重复选项的全部值，如 `cbx ui --workspace A --workspace B`。 */
  all(name: string): string[];
  /** 布尔开关是否出现；带值选项只要出现（含 `--name=` 形式）也视为 true。 */
  has(name: string): boolean;
}

function push(map: Map<string, string[]>, name: string, value: string): void {
  const list = map.get(name);
  if (list) list.push(value);
  else map.set(name, [value]);
}

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (eq >= 0) { push(values, name, arg.slice(eq + 1)); continue; }
      if (VALUE_OPTIONS.has(name)) {
        if (i + 1 >= argv.length) throw new Error(`选项 ${name} 缺少值。`);
        push(values, name, argv[i + 1]);
        i += 1;
      } else {
        flags.add(name);
      }
      continue;
    }
    positionals.push(arg);
  }
  return {
    positionals,
    option(name, fallback) { const list = values.get(name); return list && list.length > 0 ? list[0] : fallback; },
    all(name) { return values.get(name) ?? []; },
    has(name) { return flags.has(name) || values.has(name); },
  };
}
