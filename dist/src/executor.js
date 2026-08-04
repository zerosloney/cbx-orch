import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export const EXECUTOR_PLUGIN_API_VERSION = "cbx.executor/v1";
function validateManifest(value, file, enforce) {
    if (!value && !enforce)
        return {
            apiVersion: EXECUTOR_PLUGIN_API_VERSION,
            name: path.basename(file),
            version: "legacy",
            capabilities: ["execute"],
        };
    if (!value || typeof value !== "object")
        throw new Error(`executor 插件缺少 manifest：${file}`);
    const manifest = value;
    if (manifest.apiVersion !== EXECUTOR_PLUGIN_API_VERSION ||
        typeof manifest.name !== "string" ||
        !manifest.name ||
        typeof manifest.version !== "string" ||
        !manifest.version ||
        !Array.isArray(manifest.capabilities) ||
        manifest.capabilities.some((capability) => typeof capability !== "string" || !capability))
        throw new Error(`executor 插件 manifest 无效：${file}`);
    return {
        apiVersion: manifest.apiVersion,
        name: manifest.name,
        version: manifest.version,
        capabilities: [...manifest.capabilities],
    };
}
export async function inspectExecutorPlugin(spec, workspace, policy = {}) {
    const file = path.resolve(workspace, spec);
    const source = await readFile(file);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const allowPaths = (policy.allowPaths ?? []).map((allowed) => path.resolve(workspace, allowed));
    const allowSha256 = (policy.allowSha256 ?? []).map((allowed) => allowed.toLowerCase());
    if (policy.enforce) {
        if (!allowPaths.length && !allowSha256.length)
            throw new Error("plugins.enforce=true 时必须配置 allowPaths 或 allowSha256。");
        if (allowPaths.length && !allowPaths.includes(file))
            throw new Error(`插件路径未获批准：${file}`);
        if (allowSha256.length && !allowSha256.includes(sha256))
            throw new Error(`插件 SHA-256 未获批准：${file}`);
    }
    const module = (await import(pathToFileURL(file).href));
    const plugin = module.default ??
        (module.run
            ? {
                name: path.basename(file),
                run: module.run,
                manifest: module.manifest,
            }
            : undefined);
    if (!plugin || typeof plugin.run !== "function")
        throw new Error(`executor 插件没有导出 run(request)：${file}`);
    const manifest = validateManifest(plugin.manifest ?? module.manifest, file, Boolean(policy.enforce));
    return { source: "plugin", path: file, sha256, ...manifest };
}
export async function loadExecutorPlugin(spec, workspace, policy = {}, expectedSha256) {
    const file = path.isAbsolute(spec) ? spec : path.resolve(workspace, spec);
    const identity = await inspectExecutorPlugin(file, workspace, policy);
    if (expectedSha256 && identity.sha256 !== expectedSha256)
        throw new Error(`executor 插件内容在启动前发生变化：${file}`);
    const module = (await import(pathToFileURL(file).href));
    const plugin = module.default ??
        (module.run ? { name: path.basename(file), run: module.run } : undefined);
    if (!plugin || typeof plugin.run !== "function")
        throw new Error(`executor 插件没有导出 run(request)：${file}`);
    return plugin;
}
