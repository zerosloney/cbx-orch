import { spawnSync } from "node:child_process";
// permissionMode 中表示「自动放行」的语义值：opencode/pi 用各自的 flag 表达。
const AUTO_MODES = new Set(["auto", "dontAsk"]);
export const BUILTIN_EXECUTORS = [
    {
        name: "codebuddy",
        aliases: ["cbc"],
        label: "CodeBuddy",
        envVar: "CBX_CODEBUDDY",
        candidates: ["codebuddy", "cbc"],
        buildArgs: ({ prompt, permissionMode, maxTurns }) => [
            "-p",
            "--output-format", "stream-json",
            "--max-turns", String(maxTurns),
            "--permission-mode", permissionMode,
            prompt,
        ],
    },
    {
        name: "opencode",
        aliases: [],
        label: "OpenCode",
        envVar: "CBX_OPENCODE",
        candidates: ["opencode"],
        buildArgs: ({ prompt, permissionMode }) => {
            const args = ["run", "--format", "json", prompt];
            if (AUTO_MODES.has(permissionMode))
                args.push("--auto");
            return args;
        },
    },
    {
        name: "pi",
        aliases: ["oh-my-pi"], // oh-my-pi 是 pi 的扩展框架，仍由 pi 二进制执行
        label: "Pi",
        envVar: "CBX_PI",
        candidates: ["pi"],
        buildArgs: ({ prompt, permissionMode }) => {
            const args = ["-p", "--mode", "json", prompt];
            if (AUTO_MODES.has(permissionMode))
                args.push("-a");
            return args;
        },
    },
    {
        name: "omp",
        aliases: ["oh-my-pi-omp"],
        label: "omp",
        envVar: "CBX_OMP",
        candidates: ["omp"],
        // omp 官方 CLI 文档未公开 permission/auto flag；非交互 -p 默认按 omp 自身权限行事。
        // intentional-simple: 不追加 auto flag，缺已知天花板——待 omp 暴露权限 flag 后补 `-a` 类参数。
        buildArgs: ({ prompt }) => ["-p", "--mode", "json", prompt],
    },
];
const BY_NAME = (() => {
    const map = new Map();
    for (const spec of BUILTIN_EXECUTORS) {
        map.set(spec.name, spec);
        for (const alias of spec.aliases)
            map.set(alias, spec);
    }
    return map;
})();
/** 按注册名或别名解析内置执行器；未命中返回 undefined（调用方再当插件路径处理）。 */
export function resolveExecutor(name) {
    return BY_NAME.get(name);
}
// intentional-simple: 进程级缓存，只对单进程内重复调用生效。环境变量/安装变更需重启进程。
const resolvedPathCache = new Map();
/**
 * 返回 [command, ...rest] 形式的可执行命令：
 * - 优先采用 envVar 指定的覆盖路径；
 * - Windows 上用 PowerShell Get-Command 解析 bin 名的真实来源（结果缓存，避免每次 spawn 同步阻塞事件循环）；
 * - 兜底直接把候选名交给 spawn；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export function findExecutable(spec) {
    const configured = process.env[spec.envVar];
    const candidates = [];
    if (configured)
        candidates.push(configured);
    if (process.platform === "win32") {
        const primary = spec.candidates[0];
        let resolved = resolvedPathCache.get(primary);
        if (resolved === undefined) {
            const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Command ${primary}).Source`], { encoding: "utf8", windowsHide: true });
            resolved = ps.status === 0 ? String(ps.stdout).trim() : "";
            resolvedPathCache.set(primary, resolved);
        }
        if (resolved)
            candidates.push(resolved);
    }
    candidates.push(...spec.candidates);
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const lower = candidate.toLowerCase();
        if (lower.endsWith(".ps1"))
            return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate];
        if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js"))
            return [process.execPath, candidate];
        return [candidate];
    }
    throw new Error(`找不到 ${spec.label} (${spec.candidates.join("/")})。请安装 ${spec.label}，或设置 ${spec.envVar}。`);
}
