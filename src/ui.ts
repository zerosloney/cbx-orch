import { createServer, type Server, type ServerResponse } from "node:http";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { health, listArtifacts, listJobs, listQueue, loadState, readArtifact } from "./core.js";

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>CBX Orchestrator</title>
<style>
body{font:14px system-ui;margin:24px;background:#10131a;color:#e8edf5}
h1{font-size:20px}h2{font-size:15px;margin:20px 0 8px;color:#9ecbff}
.bar{padding:8px 12px;background:#171c26;border-radius:8px;margin-bottom:16px;font-size:13px}
table{width:100%;border-collapse:collapse}
td,th{padding:7px 8px;border-bottom:1px solid #2a3140;text-align:left;font-size:13px}
tr.job{cursor:pointer}
tr.job:hover{background:#171c26}
tr.job.selected{background:#1c2840;border-left:3px solid #9ecbff}
.s-done{color:#70e090}.s-failed,.s-needs_fix,.s-review_failed{color:#ff8d8d}.s-running,.s-awaiting_approval{color:#ffd166}.s-queued{color:#9ecbff}.s-cancelled{color:#888}
.v-PASS{color:#70e090;font-weight:bold}.v-FAIL{color:#ff8d8d;font-weight:bold}
#detail-panel{margin-top:16px;background:#0d1117;border-radius:8px;padding:14px;border:1px solid #2a3140;min-height:80px}
.hint{color:#555}
.stages{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.stage{padding:4px 10px;border-radius:4px;font-size:12px;border:1px solid #2a3140}
.st-pass{background:#1a3a2a;color:#70e090;border-color:#2a5a3a}
.st-fail{background:#3a1a1a;color:#ff8d8d;border-color:#5a2a2a}
.st-skip{background:#2a2a2a;color:#888}
.arrow{color:#555;font-size:11px}
.arts{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.art{padding:3px 10px;border-radius:3px;background:#171c26;cursor:pointer;font-size:12px;border:1px solid #2a3140;color:#9ecbff}
.art:hover{background:#1c2430}
.art.active{border-color:#9ecbff;background:#1c2840}
pre.art-view{white-space:pre-wrap;background:#080b11;padding:10px;border-radius:6px;max-height:350px;overflow:auto;font-size:12px;border:1px solid #2a3140;margin:0;font-family:ui-monospace,monospace}
#stream{white-space:pre-wrap;background:#0d1117;padding:10px;border-radius:6px;max-height:260px;overflow:auto;font-size:12px;margin-top:8px;border:1px solid #2a3140;font-family:ui-monospace,monospace}
.evt{padding:2px 0}.evt .t{color:#555;margin-right:8px}
</style></head><body>
<h1>CBX Orchestrator</h1>
<div class="bar" id="bar"></div>
<table><thead><tr><th>Job</th><th>Status</th><th>Phase</th><th>Attempt</th><th>Review</th><th>Updated</th></tr></thead>
<tbody id="jobs"></tbody></table>
<div id="detail-panel"><h2 style="margin-top:0">任务详情</h2><div id="detail-body"><p class="hint">点击上方任务行查看详情</p></div></div>
<h2>事件流</h2>
<div id="stream"></div>
<script>
var selected=null;
function fmt(iso){try{return new Date(iso).toLocaleTimeString()}catch(e){return iso}}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function refresh(){
  var jobs=await fetch('/api/jobs').then(function(r){return r.json()});
  var q=await fetch('/api/queue').then(function(r){return r.json()});
  document.querySelector('#bar').textContent='\\u961f\\u5217\\uff1a'+(q.paused?'\\u5df2\\u6682\\u505c':'\\u8fd0\\u884c\\u4e2d')+' \\u00b7 \\u5e76\\u53d1 '+q.maxConcurrent+' \\u00b7 '+q.entries.filter(function(x){return x.status==='running'}).length+' active \\u00b7 \\u5171 '+jobs.length+' \\u4efb\\u52a1';
  document.querySelector('#jobs').innerHTML=jobs.map(rowHtml).join('');
}
function rowHtml(j){
  var cls='job'+(selected===j.jobId?' selected':'');
  return '<tr class="'+cls+'" data-id="'+esc(j.jobId)+'"><td>'+esc(j.jobId)+'</td><td class="s-'+j.status+'">'+j.status+'</td><td>'+esc(j.phase||'')+'</td><td>'+j.attempt+'</td><td class="v-'+(j.reviewVerdict||'')+'">'+(j.reviewVerdict||'\\u2014')+'</td><td>'+fmt(j.updatedAt)+'</td></tr>';
}
function selectJob(id){
  selected=(selected===id)?null:id;
  refresh();
  if(selected){loadDetail(selected);}else{document.querySelector('#detail-body').innerHTML='<p class="hint">\\u70b9\\u51fb\\u4e0a\\u65b9\\u4efb\\u52a1\\u884c\\u67e5\\u770b\\u8be6\\u60c5</p>';}
}
async function loadDetail(id){
  var body=document.querySelector('#detail-body');
  body.innerHTML='<p>\\u52a0\\u8f7d\\u4e2d\\u2026</p>';
  var html='';
  var result=null;
  try{result=JSON.parse(await fetch('/api/jobs/'+id+'/artifact/result.json').then(function(r){return r.text()}));}catch(e){}
  if(result&&result.stages&&result.stages.length){
    html+='<div class="stages">';
    result.stages.forEach(function(s,i){
      var v=s.reviewVerdict||(s.exitCode===0?(s.testExitCode===0||s.testExitCode===null?'PASS':'FAIL'):'FAIL');
      var cls=v==='PASS'?'st-pass':v==='FAIL'?'st-fail':'st-skip';
      if(i>0)html+='<span class="arrow">\\u2192</span>';
      html+='<span class="stage '+cls+'">'+esc(s.name)+' / '+esc(s.executor)+(v?' / '+v:'')+'</span>';
    });
    html+='</div>';
  }
  var arts=[];
  try{arts=await fetch('/api/jobs/'+id+'/artifacts').then(function(r){return r.json()});}catch(e){}
  if(arts.length){
    html+='<div class="arts">';
    arts.forEach(function(a){html+='<span class="art" data-name="'+esc(a)+'">'+esc(a)+'</span>';});
    html+='</div>';
  }
  html+='<pre class="art-view" id="art-view">\\u70b9\\u51fb\\u4e0a\\u65b9\\u6587\\u4ef6\\u540d\\u67e5\\u770b\\u5185\\u5bb9</pre>';
  body.innerHTML=html;
  body.querySelectorAll('.art').forEach(function(a){
    a.addEventListener('click',function(){
      body.querySelectorAll('.art').forEach(function(x){x.classList.remove('active');});
      a.classList.add('active');
      fetch('/api/jobs/'+id+'/artifact/'+a.dataset.name).then(function(r){return r.text()}).then(function(c){
        var v=document.querySelector('#art-view');
        v.textContent=c;
        v.scrollTop=0;
      });
    });
  });
}
document.querySelector('#jobs').addEventListener('click',function(e){
  var row=e.target.closest('tr.job');if(row)selectJob(row.dataset.id);
});
refresh();setInterval(refresh,1500);
var stream=document.querySelector('#stream');
var es=new EventSource('/events');
es.onmessage=function(e){
  var d=JSON.parse(e.data);
  if(d.type==='heartbeat'||d.type==='connected')return;
  var p=d.payload||{};
  var status=p.status||'';
  var div=document.createElement('div');
  div.className='evt';
  var txt='<span class="t">'+fmt(d.at)+'</span>';
  if(p.jobId)txt+='<span class="s-'+status+'"><b>'+esc(p.jobId)+'</b></span> ';
  if(p.previousStatus)txt+='<span class="s-'+p.previousStatus+'">'+p.previousStatus+'</span> \\u2192 <span class="s-'+status+'">'+status+'</span>';
  else if(status)txt+='<span class="s-'+status+'">'+status+'</span>';
  if(p.phase)txt+=' \\u00b7 '+esc(p.phase);
  div.innerHTML=txt;
  stream.appendChild(div);
  stream.scrollTop=stream.scrollHeight;
  while(stream.children.length>200)stream.removeChild(stream.firstChild);
};
</script></body></html>`;

function json(res: ServerResponse, value: unknown, status = 200): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function text(res: ServerResponse, value: string, contentType = "text/plain; charset=utf-8"): void { res.writeHead(200, { "content-type": contentType }); res.end(value); }

/** 轮询 workspace 级 .cbx/events.ndjson 增量，解析完整行后回调。 */
function startEventTailer(workspace: string, onEvent: (event: Record<string, unknown>) => void): () => void {
  const eventsFile = path.join(workspace, ".cbx", "events.ndjson");
  let size = -1;
  let buffer = "";
  // intentional-simple: 500ms 文件大小轮询。Windows 下 fs.watch 不可靠；事件量低，开销可忽略。
  // 首次 stat 前文件不存在时设 size=0：文件首次创建后读到全部已有事件，不丢首批。
  const poll = async (): Promise<void> => {
    try {
      const s = await stat(eventsFile);
      if (size < 0) { size = s.size; return; }
      if (s.size === size) return;
      if (s.size < size) { size = s.size; return; }
      const fd = await open(eventsFile, "r");
      try {
        const buf = Buffer.alloc(s.size - size);
        await fd.read(buf, 0, buf.length, size);
        buffer += buf.toString("utf8");
        size = s.size;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) { try { onEvent(JSON.parse(line)); } catch { /* partial/corrupt line */ } }
        }
      } finally { await fd.close(); }
    } catch (error) {
      // 文件不存在时初始化基线为 0，避免文件首次创建后把已有内容当历史跳过。
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && size < 0) size = 0;
    }
  };
  const timer = setInterval(poll, 500);
  timer.unref();
  return () => clearInterval(timer);
}

export function createWebUiServer(workspace: string, host = "127.0.0.1", port = 4173): Server {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) throw new Error("Web UI 仅允许绑定到本机回环地址；远程访问需要在受认证的反向代理后显式实现。");
  const clients = new Set<ServerResponse>();
  const broadcast = (event: Record<string, unknown>): void => {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const stopTailer = startEventTailer(workspace, broadcast);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return json(res, { error: "method not allowed" }, 405);
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/") return text(res, page, "text/html; charset=utf-8");
      if (url.pathname === "/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), type: "connected" })}\n\n`); req.on("close", () => clients.delete(res)); return; }
      if (url.pathname === "/api/jobs") return json(res, await listJobs(workspace));
      if (url.pathname === "/api/queue") return json(res, await listQueue(workspace));
      if (url.pathname === "/healthz" || url.pathname === "/api/metrics") return json(res, await health(workspace));
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (job) return json(res, await loadState(workspace, job[1]));
      const artifacts = /^\/api\/jobs\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (artifacts) return json(res, await listArtifacts(workspace, artifacts[1]));
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
  server.on("close", () => { clearInterval(heartbeat); stopTailer(); });
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
