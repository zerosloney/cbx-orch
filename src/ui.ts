import { createServer, type Server, type ServerResponse } from "node:http";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { health, listArtifacts, listJobs, listQueue, loadState, readArtifact } from "./core.js";
import { capture } from "./process-runner.js";

interface WorkspaceSummary {
  path: string;
  name: string;
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  paused: boolean;
  activeExecutors: number;
  lastActivityAt: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
}

async function summarizeWorkspace(workspace: string): Promise<WorkspaceSummary> {
  const [jobs, queue] = await Promise.all([listJobs(workspace), listQueue(workspace)]);
  const jobsByStatus: Record<string, number> = {};
  let activeExecutors = 0;
  let lastActivityAt: string | null = null;
  for (const job of jobs) {
    const status = String(job.status);
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
    if (status === "running") activeExecutors += 1;
    const updated = String(job.updatedAt ?? "");
    if (updated && (!lastActivityAt || updated > lastActivityAt)) lastActivityAt = updated;
  }
  const queueDepth = (queue.entries ?? []).filter((entry) => ["queued", "running", "awaiting_approval"].includes(String(entry.status))).length;
  let gitBranch: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    const branch = capture(["git", "branch", "--show-current"], workspace);
    if (branch.code === 0) gitBranch = branch.stdout.trim() || null;
    const statusResult = capture(["git", "status", "--porcelain"], workspace);
    if (statusResult.code === 0) gitDirty = Boolean(statusResult.stdout.trim());
  } catch { /* not a git repo, leave null */ }
  return {
    path: workspace,
    name: path.basename(workspace) || workspace,
    jobsByStatus,
    queueDepth,
    paused: Boolean(queue.paused),
    activeExecutors,
    lastActivityAt,
    gitBranch,
    gitDirty,
  };
}

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
.job-select{background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer;text-align:left}
.job-select:focus-visible,.art:focus-visible{outline:2px solid #9ecbff;outline-offset:2px}
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
.art{padding:3px 10px;border-radius:3px;background:#171c26;cursor:pointer;font:inherit;font-size:12px;border:1px solid #2a3140;color:#9ecbff}
.art:hover{background:#1c2430}
.art.active{border-color:#9ecbff;background:#1c2840}
pre.art-view{white-space:pre-wrap;background:#080b11;padding:10px;border-radius:6px;max-height:350px;overflow:auto;font-size:12px;border:1px solid #2a3140;margin:0;font-family:ui-monospace,monospace}
#stream{white-space:pre-wrap;background:#0d1117;padding:10px;border-radius:6px;max-height:260px;overflow:auto;font-size:12px;margin-top:8px;border:1px solid #2a3140;font-family:ui-monospace,monospace}
.evt{padding:2px 0}.evt .t{color:#555;margin-right:8px}
.topbar{display:flex;align-items:center;gap:12px;margin:4px 0 12px;font-size:13px}
.topbar h1{margin:0;display:inline}
.ws-pill{padding:5px 12px;background:#171c26;border-radius:6px;display:inline-flex;align-items:center;gap:8px}
.ws-pill .ws-name{font-weight:bold;color:#9ecbff}
.ws-pill .ws-count{color:#888;font-size:12px}
.ws-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.ws-chip{padding:5px 10px;border-radius:4px;background:#171c26;border:1px solid #2a3140;cursor:pointer;font:inherit;font-size:12px;color:inherit;display:inline-flex;align-items:center;gap:6px}
.ws-chip:hover{background:#1c2430}
.ws-chip.active{border-color:#9ecbff;background:#1c2840;color:#9ecbff}
.ws-chip .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:16px}
.card{background:#171c26;padding:10px 14px;border-radius:6px;border:1px solid #2a3140;min-width:0}
.card-label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-value{font-size:18px;font-weight:bold;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-value.s-failed,.card-value.s-review_failed{color:#ff8d8d}
.card-value.s-running,.card-value.s-awaiting_approval{color:#ffd166}
.card-value.s-done{color:#70e090}
</style></head><body>
<div class="topbar"><h1>CBX Orchestrator</h1><span class="ws-pill"><span class="ws-name" id="ws-name">—</span><span class="ws-count" id="ws-count"></span></span></div>
<div class="ws-list" id="ws-list" hidden></div>
<div class="cards" id="cards">
  <div class="card"><div class="card-label">总任务</div><div class="card-value" id="c-total">—</div></div>
  <div class="card"><div class="card-label">运行中 / 并发</div><div class="card-value" id="c-running">—</div></div>
  <div class="card"><div class="card-label">失败</div><div class="card-value" id="c-failed">—</div></div>
  <div class="card"><div class="card-label">队列</div><div class="card-value" id="c-queue">—</div></div>
  <div class="card"><div class="card-label">最后活动</div><div class="card-value" id="c-last">—</div></div>
  <div class="card"><div class="card-label">健康</div><div class="card-value" id="c-health">—</div></div>
</div>
<div class="bar" id="bar" hidden></div>
<table><thead><tr><th>Job</th><th>Status</th><th>Phase</th><th>Attempt</th><th>Review</th><th>Updated</th></tr></thead>
<tbody id="jobs"></tbody></table>
<div id="detail-panel"><h2 style="margin-top:0">任务详情</h2><div id="detail-body"><p class="hint">点击上方任务行查看详情</p></div></div>
<h2>事件流</h2>
<div id="stream"></div>
<script>
var allWorkspaces=[];
var currentWorkspace=null;
var selected=null;
function rowAttr(id){return String(id).replace(/[^\w-]/g,function(c){return'\\'+c})}
function totalJobs(w){return Object.values(w.jobsByStatus||{}).reduce(function(a,b){return a+b;},0)}
function fmt(iso){try{return new Date(iso).toLocaleTimeString()}catch(e){return iso}}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function refresh(){
  var ws=encodeURIComponent(currentWorkspace||'');
  var jobs=await fetch('/api/jobs?workspace='+ws).then(function(r){return r.json()});
  var q=await fetch('/api/queue?workspace='+ws).then(function(r){return r.json()});
  updateCards(jobs,q);
  document.querySelector('#jobs').innerHTML=jobs.map(rowHtml).join('');
  if(selected){var row=document.querySelector('tr.job[data-id="'+rowAttr(selected)+'"]');if(row)row.classList.add('selected');}
}
function updateCards(jobs,q){
  var total=jobs.length;
  var running=jobs.filter(function(j){return j.status==='running';}).length;
  var failed=jobs.filter(function(j){return['failed','review_failed','needs_fix'].indexOf(j.status)>=0;}).length;
  var active=(q.entries||[]).filter(function(e){return e.status==='running';}).length;
  var depth=(q.entries||[]).filter(function(e){return['queued','running','awaiting_approval'].indexOf(e.status)>=0;}).length;
  var last=jobs.reduce(function(m,j){return j.updatedAt>m?j.updatedAt:m;},'');
  var cTotal=document.querySelector('#c-total');cTotal.textContent=total;cTotal.className='card-value';
  var cRun=document.querySelector('#c-running');cRun.textContent=running+' / '+(q.maxConcurrent||'\u2014');cRun.className='card-value'+(running>0?' s-running':'');
  var cFail=document.querySelector('#c-failed');cFail.textContent=failed;cFail.className='card-value'+(failed>0?' s-failed':'');
  var cQ=document.querySelector('#c-queue');cQ.textContent=depth+(q.paused?' (\u6682\u505c)':'');cQ.className='card-value'+(q.paused?' s-running':'');
  document.querySelector('#c-last').textContent=last?fmt(last):'\u2014';
  var health=document.querySelector('#c-health');
  health.textContent=(q.paused?'\u6682\u505c':failed>0?failed+'\u4e2a\u5931\u8d25':active>0?'\u8fd0\u884c\u4e2d':'\u7a7a\u95f2');
  health.className='card-value'+(q.paused?' s-running':failed>0?' s-failed':active>0?' s-running':' s-done');
}
async function loadWorkspaces(){
  try{var data=await fetch('/api/workspaces').then(function(r){return r.json()});allWorkspaces=data.workspaces||[];currentWorkspace=data.default;}catch(e){return}
  var qs=new URLSearchParams(location.search);
  var req=qs.get('workspace');
  if(req&&allWorkspaces.some(function(w){return w.path===req;}))currentWorkspace=req;
  renderWorkspaces();
}
function renderWorkspaces(){
  var list=document.querySelector('#ws-list');
  if(allWorkspaces.length>1){
    list.hidden=false;
    list.innerHTML=allWorkspaces.map(function(w){
      var t=totalJobs(w);var failed=(w.jobsByStatus&&w.jobsByStatus.failed)||0;
      var dot=failed>0?'#ff8d8d':(w.activeExecutors>0?'#ffd166':'#70e090');
      var active=w.path===currentWorkspace?' active':'';
      return '<button class="ws-chip'+active+'" data-path="'+esc(w.path)+'"><span class="dot" style="background:'+dot+'"></span><span>'+esc(w.name)+'</span><span style="color:#888">'+t+(failed>0?' \u00b7 '+failed+' fail':'')+'</span></button>';
    }).join('');
    list.querySelectorAll('.ws-chip').forEach(function(b){b.addEventListener('click',function(){switchWorkspace(b.dataset.path);});});
  } else { list.hidden=true; }
  var cur=allWorkspaces.find(function(w){return w.path===currentWorkspace;});
  document.querySelector('#ws-name').textContent=cur?cur.name:(currentWorkspace||'\u2014');
  document.querySelector('#ws-count').textContent=cur?'('+totalJobs(cur)+')':'';
}
function switchWorkspace(path){
  if(path===currentWorkspace||!allWorkspaces.some(function(w){return w.path===path;}))return;
  currentWorkspace=path;
  var qs=new URLSearchParams(location.search);qs.set('workspace',path);
  history.replaceState(null,'','?'+qs.toString());
  selected=null;renderWorkspaces();refresh();
  document.querySelector('#detail-body').innerHTML='<p class="hint">\u70b9\u51fb\u4e0a\u65b9\u4efb\u52a1\u884c\u67e5\u770b\u8be6\u60c5</p>';
}
function rowHtml(j){
  var cls='job'+(selected===j.jobId?' selected':'');
  return '<tr class="'+cls+'" data-id="'+esc(j.jobId)+'"><td><button type="button" class="job-select">'+esc(j.jobId)+'</button></td><td class="s-'+j.status+'">'+j.status+'</td><td>'+esc(j.phase||'')+'</td><td>'+j.attempt+'</td><td class="v-'+(j.reviewVerdict||'')+'">'+(j.reviewVerdict||'\\u2014')+'</td><td>'+fmt(j.updatedAt)+'</td></tr>';
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
    arts.forEach(function(a){html+='<button type="button" class="art" data-name="'+esc(a)+'">'+esc(a)+'</button>';});
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
loadWorkspaces().then(refresh);
setInterval(refresh,1500);
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

export function createWebUiServer(workspace: string | string[], host = "127.0.0.1", port = 4173): Server {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) throw new Error("Web UI 仅允许绑定到本机回环地址；远程访问需要在受认证的反向代理后显式实现。");
  const workspaces = Array.isArray(workspace) ? workspace : [workspace];
  // 默认 workspace:多 workspace 时取第一个,单 workspace 时取该值。客户端可经 ?workspace=<encoded> 覆盖。
  const defaultWorkspace = workspaces[0] ?? ".";
  const clients = new Set<ServerResponse>();
  const broadcast = (event: Record<string, unknown>): void => {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(message);
  };
  // 为每个 workspace 启动独立 tailer;事件附 workspace 字段,前端可按 workspace 过滤着色。
  const stopTailers: Array<() => void> = [];
  for (const ws of workspaces) {
    const tailer = startEventTailer(ws, (event) => broadcast({ ...event, workspace: ws }));
    stopTailers.push(tailer);
  }
  // 从 URL query 中选 workspace;不在白名单内时降级到 default,避免任意路径枚举。
  const resolveWorkspace = (url: URL): string => {
    const requested = url.searchParams.get("workspace");
    if (requested) {
      const resolved = path.resolve(decodeURIComponent(requested));
      if (workspaces.some((item) => item === resolved)) return resolved;
    }
    return defaultWorkspace;
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return json(res, { error: "method not allowed" }, 405);
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/") return text(res, page, "text/html; charset=utf-8");
      if (url.pathname === "/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), type: "connected", workspaces })}\n\n`); req.on("close", () => clients.delete(res)); return; }
      if (url.pathname === "/api/workspaces") {
        const summaries = await Promise.all(workspaces.map((ws) => summarizeWorkspace(ws).catch((error) => ({ path: ws, name: path.basename(ws) || ws, error: error instanceof Error ? error.message : String(error) }))));
        return json(res, { workspaces: summaries, default: defaultWorkspace });
      }
      const ws = resolveWorkspace(url);
      if (url.pathname === "/api/jobs") return json(res, await listJobs(ws));
      if (url.pathname === "/api/queue") return json(res, await listQueue(ws));
      if (url.pathname === "/healthz" || url.pathname === "/api/metrics") return json(res, await health(ws));
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (job) return json(res, await loadState(ws, job[1]));
      const artifacts = /^\/api\/jobs\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (artifacts) return json(res, await listArtifacts(ws, artifacts[1]));
      const artifact = /^\/api\/jobs\/([^/]+)\/artifact\/([^/]+)$/.exec(url.pathname);
      if (artifact) return text(res, await readArtifact(ws, artifact[1], artifact[2]));
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
  server.on("close", () => { clearInterval(heartbeat); for (const stop of stopTailers) stop(); });
  return server;
}

export async function startWebUi(workspace: string | string[], port = 4173, host = "127.0.0.1"): Promise<void> {
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
