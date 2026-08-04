import { createServer, type Server, type ServerResponse } from "node:http";
import { health, listJobs, listQueue, loadState, readArtifact } from "./core.js";

const page = `<!doctype html><html><head><meta charset="utf-8"><title>CBX Orchestrator</title><style>body{font:14px system-ui;margin:24px;background:#10131a;color:#e8edf5}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #2a3140;text-align:left}.done{color:#70e090}.failed,.needs_fix{color:#ff8d8d}.running{color:#ffd166}.queued{color:#9ecbff}pre{white-space:pre-wrap;background:#171c26;padding:12px;border-radius:8px}</style></head><body><h1>CBX Orchestrator</h1><div id="queue"></div><table><thead><tr><th>Job</th><th>Status</th><th>Phase</th><th>Attempt</th><th>Updated</th></tr></thead><tbody id="jobs"></tbody></table><pre id="event">等待事件…</pre><script>
async function refresh(){const [jobs,q]=await Promise.all([fetch('/api/jobs').then(r=>r.json()),fetch('/api/queue').then(r=>r.json())]);document.querySelector('#queue').textContent='队列：'+(q.paused?'已暂停':'运行中')+' · 并发 '+q.maxConcurrent+' · '+q.entries.filter(x=>x.status==='running').length+' active';document.querySelector('#jobs').innerHTML=jobs.map(j=>'<tr><td>'+j.jobId+'</td><td class="'+j.status+'">'+j.status+'</td><td>'+j.phase+'</td><td>'+j.attempt+'</td><td>'+j.updatedAt+'</td></tr>').join('')}refresh();setInterval(refresh,1500);const events=new EventSource('/events');events.onmessage=e=>document.querySelector('#event').textContent=e.data;
</script></body></html>`;

function json(res: ServerResponse, value: unknown, status = 200): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function text(res: ServerResponse, value: string, contentType = "text/plain; charset=utf-8"): void { res.writeHead(200, { "content-type": contentType }); res.end(value); }

export function createWebUiServer(workspace: string, host = "127.0.0.1", port = 4173): Server {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) throw new Error("Web UI 仅允许绑定到本机回环地址；远程访问需要在受认证的反向代理后显式实现。");
  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return json(res, { error: "method not allowed" }, 405);
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/") return text(res, page, "text/html; charset=utf-8");
      if (url.pathname === "/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), type: "connected" })}\n\n`); req.on("close", () => clients.delete(res)); return; }
      if (url.pathname === "/api/jobs") return json(res, await import("./core.js").then(mod => mod.listJobs(workspace)));
      if (url.pathname === "/api/queue") return json(res, await listQueue(workspace));
      if (url.pathname === "/healthz" || url.pathname === "/api/metrics") return json(res, await health(workspace));
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (job) return json(res, await loadState(workspace, job[1]));
      const artifact = /^\/api\/jobs\/([^/]+)\/artifact\/([^/]+)$/.exec(url.pathname);
      if (artifact) return text(res, await readArtifact(workspace, artifact[1], artifact[2]));
      return json(res, { error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException)?.code;
      const status = code === "ENOENT" ? 404 : message.includes("不允许读取") ? 403 : message.includes("无效的任务 ID") ? 400 : 500;
      json(res, { error: message }, status);
    }
  });
  const heartbeat = setInterval(() => { const message = `data: ${JSON.stringify({ at: new Date().toISOString(), type: "heartbeat" })}\n\n`; for (const client of clients) client.write(message); }, 1500);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  return server;
}

export async function startWebUi(workspace: string, port = 4173, host = "127.0.0.1"): Promise<void> {
  const server = createWebUiServer(workspace, host, port);
  await new Promise<void>(resolve => server.listen(port, host, resolve));
  console.log(`CBX UI: http://${host}:${port}`);
  await new Promise<void>(resolve => server.on("close", resolve));
}

export async function runTui(workspace: string, intervalMs = 1000): Promise<void> {
  let stopped = false;
  process.once("SIGINT", () => { stopped = true; });
  while (!stopped) {
    const [jobs, queue] = await Promise.all([import("./core.js").then(mod => mod.listJobs(workspace)), listQueue(workspace)]);
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`CBX Orchestrator TUI · queue=${queue.paused ? "paused" : "running"} · active=${queue.entries.filter(entry => entry.status === "running").length}/${queue.maxConcurrent}\n\n`);
    for (const job of jobs.slice(0, 30)) process.stdout.write(`${job.jobId.padEnd(28)} ${String(job.status).padEnd(16)} ${job.phase}\n`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
