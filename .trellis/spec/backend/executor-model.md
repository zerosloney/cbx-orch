# Executor Model

## 1. Executor Types

Two executor categories: **builtin** (bundled adapters) and **plugin** (dynamic loading).

### Builtin Executors

Located in `src/executors/builtin.ts`. Currently registered: `codebuddy`, `opencode`, `omp`, `cline`.

```typescript
interface BuiltinExecutor {
  name: "codebuddy" | "opencode" | "omp" | "cline";
  aliases: string[];        // alternate names that resolveExecutor() also matches
  label: string;            // display name injected into prompts
  envVar: string;           // env var override, e.g. "OPENCODE_BIN"
  candidates: string[];     // binary names tried in order on PATH
  buildArgs(opts: BuildArgsOptions): string[];
}
```

Each adapter translates the uniform `BuildArgsOptions` to the specific CLI's argument format:

```typescript
interface BuildArgsOptions {
  prompt: string;
  permissionMode: string;  // "default" | "auto" | "dontAsk" | "never" | "isolated"
  maxTurns: number;
}
```

### Permission Mode Mapping

`permissionMode` encodes the level of agent autonomy:

| Mode | codebuddy | opencode | cline |
|------|-----------|----------|-------|
| `default` | (default) | (default) | (default) |
| `auto` / `dontAsk` | `--auto` | `--auto` | `--auto-approve true` |
| `never` | `--never` | `--never` | (reject) |
| `isolated` | `--isolated` | `--isolated` | `--isolated` |

### Plugin Executors

Dynamic executors loaded from arbitrary paths. Configured in `.cbx.json`:

```json
{
  "plugins": {
    "enforce": true,
    "allowPaths": ["/usr/local/lib/cbx-plugins"],
    "allowSha256": ["abc123..."]
  }
}
```

---

## 2. Executor Invocation Flow

`invokeExecutor()` in `src/runner.ts`:

```
resolveExecutor(name)
  ├→ Builtin命中 → invokeBuiltin()
  └→ 未命中 → load as plugin path
        ├→ inspectExecutorPlugin()   → get manifest
        ├→ check plugins.enforce    → warn if bypass
        ├→ write ExecutorRequest to plugin-request.json
        └→ spawn plugin-host.js with (executor, workspace, requestFile, resultFile)
```

### ExecutorRequest / ExecutorResult

```typescript
// src/executor.ts
interface ExecutorRequest {
  directory: string;       // job working directory
  workdir: string;        // worktree path
  prompt: string;         // full prompt text
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  executor: string;       // executor name
  plugin?: {
    policy: RuntimeConfig["plugins"];
    sha256: string;       // plugin binary SHA-256
  };
}

interface ExecutorResult {
  code: number | null;
  output: string | null;
  timedOut: boolean | null;
}
```

### Plugin Host

`src/plugin-host.js` receives the executor name + request file, loads the plugin module, calls `execute(request)`, and writes the result. The plugin module must export:

```typescript
interface ExecutorPlugin {
  apiVersion: 1;
  name: string;
  version: string;
  capabilities: string[];
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
}
```

---

## 3. Executor Discovery

`resolveExecutor()` matches by `name` or any `alias` in the `BUILTIN_EXECUTORS` map. Unmatched names are treated as plugin paths.

`findExecutable()` resolves a `BuiltinExecutor` to an absolute command:

1. Check `process.env[spec.envVar]`
2. Walk `process.env.PATH`, try each `spec.candidates`
3. Return `["/path/to/binary", ...buildArgs]`

The result is cached in a `Map` (process-level, not persistent).

---

## 4. Prompt Construction

`promptFor()` in `src/runner.ts` builds the agent prompt:

```typescript
function promptFor(
  phase: string,
  extra: string = "",
  label: string = "编码代理",
  contextPack: string   // path to context snapshot file
): string {
  return `你是 ${label} 执行代理。
只读取当前角色上下文包：
- ${contextPack}

上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。
当前阶段：${phase}
${extra}`;
}
```

The `phase` string describes where in the execution lifecycle the agent is running (e.g., `"run-stage"`, `"review"`, `"stop-gate review"`).

---

## 5. Process Lifecycle

All executor processes are spawned via `runProcess()` in `src/process-runner.ts`:

- `stdout`/`stderr` appended to `agent.log` in real-time
- PID written to `active.pid` in the job directory
- On timeout or explicit cancel: `terminateTree()` sends SIGINT → SIGKILL to the process group

### Event Log

Each executor invocation emits structured events to `events.ndjson`:

```json
{"event":"executor_metadata","source":"builtin","name":"opencode","version":"1.0.0","at":"..."}
{"event":"process_started","command":[...],"cwd":"...","at":"..."}
{"event":"process_finished","returncode":0,"timedOut":false,"at":"..."}
```

Plugin invocations additionally emit:
```json
{"event":"plugin_started","executor":"my-plugin","at":"..."}
{"event":"plugin_finished","executor":"my-plugin","code":0,"timedOut":false,"at":"..."}
```

---

## 6. Test Execution

`runTest()` in `src/runner.ts` runs `context.testCommand` separately from the executor:

```typescript
async function runTest(
  directory: string,
  workdir: string,
  command: string | undefined,
  timeoutMs: number
): Promise<ProcessResult>
```

- `command` is `undefined` → writes `"未指定测试命令。\n"` to `test.log`, returns `{ code: 0 }`
- Output appended to `test.log`
- Exit code, timeout flag, and output truncation flag written to `test.log` footer

---

## 7. Builtin Executor Spec

### opencode

| Field | Value |
|-------|-------|
| `name` | `"opencode"` |
| `aliases` | `["oh-my-pi"]` |
| `envVar` | `"OPENCODE_BIN"` |
| `candidates` | `["opencode"]` |
| `buildArgs` | `[promptArg, "--permission", permissionMode, "--max-turns", maxTurns]` |

### codebuddy

| Field | Value |
|-------|-------|
| `name` | `"codebuddy"` |
| `aliases` | `[]` |
| `envVar` | `"CODEBUDDY_BIN"` |
| `candidates` | `["codebuddy"]` |
| `buildArgs` | `[promptArg, "--permission", permissionMode, "--max-turns", maxTurns]` |

### omp

| Field | Value |
|-------|-------|
| `name` | `"omp"` |
| `aliases` | `[]` |
| `envVar` | `"OMP_BIN"` |
| `candidates` | `["omp"]` |
| `buildArgs` | `[promptArg, "--permission", permissionMode, "--max-turns", maxTurns]` |

### cline

| Field | Value |
|-------|-------|
| `name` | `"cline"` |
| `aliases` | `[]` |
| `envVar` | `"CLINE_BIN"` |
| `candidates` | `["cline"]` |
| `buildArgs` | `[promptArg, "--auto-approve", autoApprove, "--max-turns", maxTurns]` |

---

## 8. Plugin Security

When `plugins.enforce: true`:
- Only plugins whose path matches an `allowPaths` entry and whose SHA-256 matches `allowSha256` are loaded
- A warning is emitted to `stderr` if `enforce: false` and a plugin is used

```typescript
// runner.ts line 35-38
const warning = `executor 指向插件 ${identity.path}，但 plugins.enforce 未启用，
  插件未经路径/SHA 白名单校验即被加载；生产环境请配置 plugins.enforce=true 与 allowPaths/allowSha256。`;
```

---

## 9. Anti-Patterns

### Don't: Resolve executor inside hot loops

`resolveExecutor()` is called once per executor invocation. The result is cheap, but in multi-stage chains, avoid calling it repeatedly with the same name.

### Don't: Pass untrusted prompts to `buildArgs`

`buildArgs` receives a `prompt` string. The CLI adapter may shell out directly. Prompt injection is not mitigated at the executor layer — trust boundary enforcement happens before this point.

### Don't: Ignore `timedOut` on executor result

Even when `code === 0`, a `timedOut: true` indicates the process was killed after the timeout. Treat both `code !== 0` and `timedOut === true` as failure conditions.
