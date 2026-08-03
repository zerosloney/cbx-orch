#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadExecutorPlugin, type ExecutorRequest } from "./executor.js";

async function main(): Promise<void> {
  const [executor, workspace, requestFile] = process.argv.slice(2);
  if (!executor || !workspace || !requestFile) throw new Error("plugin host 缺少参数");
  const plugin = await loadExecutorPlugin(executor, workspace);
  const request = JSON.parse(await readFile(requestFile, "utf8")) as ExecutorRequest;
  const result = await plugin.run(request);
  process.stdout.write(`\nCBX_PLUGIN_RESULT=${Buffer.from(JSON.stringify(result), "utf8").toString("base64")}\n`);
}

main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
