import { createServer, type Server, type ServerResponse } from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { health, jobDir, listArtifacts, listJobs, listQueue, loadState, readArtifact } from "./core.js";
import { capture } from "./process-runner.js";
import { processAlive } from "./storage.js";

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

interface TimelineStage { name: string; phase?: string; startedAt: string; endedAt: string | null; durationMs: number | null; }
interface JobTimeline { stages: TimelineStage[]; currentStage: string | null; startedAt: string | null; finishedAt: string | null; elapsedSec: number; }

const TERMINAL_STATUSES = new Set(["done", "failed", "review_failed", "cancelled"]);

/**
 * 从 events.ndjson 推导阶段时间线。兼容两套事件:
 * - 新格式(0.10.2+):job.state_changed 事件携带 status 维度
 * - 老格式(<=0.10.1):stage_started / stage_finished 配对携带 stage 维度
 * 优先用新格式;若不存在则用老格式配对构造。
 */
export async function buildTimeline(workspace: string, jobId: string): Promise<JobTimeline> {
  const eventsFile = path.join(jobDir(workspace, jobId), "events.ndjson");
  let raw = "";
  try { raw = await readFile(eventsFile, "utf8"); } catch { /* 任务还没产生事件 */ }
  const stateChanges: Array<{ status: string; phase?: string; at: string }> = [];
  const stageStarts: Array<{ stage: string; executor: string; index: number; at: string }> = [];
  const stageEnds: Array<{ stage: string; index: number; exitCode?: number; reviewVerdict?: string; at: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const at = String(event.at ?? "");
    if (event.event === "job.state_changed" && typeof event.status === "string") {
      stateChanges.push({ status: String(event.status), phase: typeof event.phase === "string" ? event.phase : undefined, at });
    } else if (event.event === "stage_started" && typeof event.stage === "string") {
      stageStarts.push({ stage: String(event.stage), executor: String(event.executor ?? ""), index: Number(event.index ?? 0), at });
    } else if (event.event === "stage_finished" && typeof event.stage === "string") {
      stageEnds.push({ stage: String(event.stage), index: Number(event.index ?? 0), exitCode: typeof event.exitCode === "number" ? event.exitCode : undefined, reviewVerdict: typeof event.reviewVerdict === "string" ? event.reviewVerdict : undefined, at });
    }
  }
  // 优先用 state_changes(更新更详细);老格式 jobs 没有 state_change,用 stage_started/finished 配对
  let stages: TimelineStage[];
  let currentStage: string | null;
  let startedAt: string | null;
  let finishedAt: string | null;
  if (stateChanges.length) {
    stages = [];
    for (let i = 0; i < stateChanges.length; i += 1) {
      const cur = stateChanges[i];
      const next = stateChanges[i + 1];
      const end = next ? next.at : null;
      const durationMs = end && cur.at ? Date.parse(end) - Date.parse(cur.at) : null;
      stages.push({ name: cur.status, phase: cur.phase, startedAt: cur.at, endedAt: end, durationMs });
    }
    const last = stateChanges[stateChanges.length - 1];
    currentStage = last ? last.status : null;
    startedAt = stateChanges[0]?.at ?? null;
    finishedAt = currentStage && TERMINAL_STATUSES.has(currentStage) ? last?.at ?? null : null;
  } else {
    // 老格式配对:用 stage_started/finished 构造 timeline
    stages = stageStarts.map((start) => {
      const end = stageEnds.find((finish) => finish.stage === start.stage && finish.index === start.index);
      const endAt = end?.at ?? null;
      const durationMs = endAt ? Date.parse(endAt) - Date.parse(start.at) : null;
      const verdict = end?.reviewVerdict;
      return { name: start.stage, phase: verdict ? `${start.executor} (${verdict})` : start.executor, startedAt: start.at, endedAt: endAt, durationMs };
    });
    const lastEnd = stageEnds[stageEnds.length - 1];
    const firstStart = stageStarts[0];
    currentStage = lastEnd ? `${lastEnd.stage} (${lastEnd.reviewVerdict ?? "done"})` : (firstStart?.stage ?? null);
    startedAt = firstStart?.at ?? null;
    finishedAt = lastEnd?.at ?? null;
  }
  const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) : 0;
  return { stages, currentStage, startedAt, finishedAt, elapsedSec };
}

interface ExecutorStatus {
  pid: number | null;
  alive: boolean | null;
  heartbeatAt: string | null;
  heartbeatStaleSec: number | null;
  startedAt: string | null;
  elapsedSec: number | null;
  command: string | null;
}

/** 读取任务当前 executor 进程状态:pid/active.pid、worker.heartbeat、process_started 命令。 */
export async function readExecutorStatus(workspace: string, jobId: string): Promise<ExecutorStatus> {
  const dir = jobDir(workspace, jobId);
  // executor 子进程 pid 优先;worker pid 兜底(已 detached 时仅 worker 文件在)。
  let pid: number | null = null;
  for (const name of ["active.pid", "pid"]) {
    try { pid = Number((await readFile(path.join(dir, name), "utf8")).trim()); if (Number.isSafeInteger(pid) && pid > 0) break; } catch { continue; }
    pid = null;
  }
  const alive = pid !== null ? processAlive(pid) : null;
  let heartbeatAt: string | null = null;
  let heartbeatStaleSec: number | null = null;
  try {
    const s = await stat(path.join(dir, "worker.heartbeat"));
    heartbeatAt = s.mtime.toISOString();
    heartbeatStaleSec = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000));
  } catch { /* no heartbeat file */ }
  let startedAt: string | null = null;
  let elapsedSec: number | null = null;
  try {
    const s = await stat(path.join(dir, "pid"));
    startedAt = s.mtime.toISOString();
    elapsedSec = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000));
  } catch { /* no pid file */ }
  // 从 events.ndjson 抓最近一次 process_started 的命令(用于 UI 展示「codebuddy -p ...」)。
  let command: string | null = null;
  try {
    const raw = await readFile(path.join(dir, "events.ndjson"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event.event === "process_started" && Array.isArray(event.command)) {
        command = (event.command as unknown[]).map((part) => String(part)).join(" ");
      }
    }
  } catch { /* no events */ }
  return { pid, alive, heartbeatAt, heartbeatStaleSec, startedAt, elapsedSec, command };
}

interface AgentLogChunk { content: string; nextOffset: number; truncated: boolean; }

/** 增量读 agent.log(类比 readEventsIncremental):since=0 全量,since>0 按 offset 续读。 */
export async function readAgentLogIncremental(workspace: string, jobId: string, since = 0, maxBytes = 256 * 1024): Promise<AgentLogChunk> {
  const file = path.join(jobDir(workspace, jobId), "agent.log");
  let raw: Buffer;
  try { raw = await readFile(file); } catch { return { content: "", nextOffset: 0, truncated: false }; }
  // agent.log 可能很大;只读最后 maxBytes 字节避免前端一次塞爆。
  const start = raw.length > maxBytes ? raw.length - maxBytes : 0;
  const slice = raw.subarray(start);
  const text = slice.toString("utf8");
  // 简单行计数:取首 since 行跳过,但这里用字节位置;返回 nextOffset 供下次续读。
  const content = text;
  return { content, nextOffset: raw.length, truncated: start > 0 };
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
.tabs{display:flex;gap:2px;margin:0 0 10px;border-bottom:1px solid #2a3140}
.tab{padding:6px 12px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font:inherit;font-size:12px}
.tab:hover{color:#e8edf5}
.tab.active{color:#9ecbff;border-bottom-color:#9ecbff}
.tab-panel{display:none;background:#0d1117;padding:12px;border-radius:6px;border:1px solid #2a3140;font-size:12px;max-height:420px;overflow:auto}
.tab-panel.active{display:block}
.timeline-row{display:flex;align-items:center;gap:6px;padding:3px 0}
.timeline-bar{height:8px;border-radius:4px;min-width:4px}
.timeline-name{width:140px;flex-shrink:0;font-size:12px}
.timeline-dur{width:80px;flex-shrink:0;color:#888;font-size:11px;font-variant-numeric:tabular-nums}
.timeline-at{color:#555;font-size:11px;margin-left:auto}
.exec-card{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.exec-card .field-label{color:#888;font-size:11px;text-transform:uppercase}
.exec-card .field-value{font-size:13px;word-break:break-all}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.pulse-alive{background:#70e090;box-shadow:0 0 6px #70e090}
.pulse-dead{background:#ff8d8d}
.pulse-unknown{background:#888}
.cmd{font-family:ui-monospace,monospace;font-size:11px;color:#9ecbff;background:#080b11;padding:6px 8px;border-radius:4px;word-break:break-all;margin-top:4px}
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
<table><thead><tr><th>Job</th><th>Status</th><th>Phase</th><th>Attempt</th><th>Review</th><th>Elapsed</th><th>Updated</th></tr></thead>
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
function fmtElapsed(iso) {
  if (!iso) return '\u2014';
  var ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return '\u2014';
  if (ms < 1000) return Math.floor(ms) + 'ms';
  if (ms < 60_000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm ' + Math.floor((ms % 60_000) / 1000) + 's';
  return Math.floor(ms / 3600_000) + 'h ' + Math.floor((ms % 3600_000) / 60_000) + 'm';
}
function rowHtml(j){
  var cls='job'+(selected===j.jobId?' selected':'');
  // 终态显示 totalSeconds,非终态用 createdAt 实时算 elapsed。
  var terminal=['done','failed','review_failed','cancelled','needs_fix'].indexOf(j.status)>=0;
  var elapsed = terminal && j.totalSeconds != null ? (j.totalSeconds < 60 ? j.totalSeconds + 's' : Math.floor(j.totalSeconds/60) + 'm ' + (j.totalSeconds%60) + 's') : fmtElapsed(j.createdAt);
  return '<tr class="'+cls+'" data-id="'+esc(j.jobId)+'" data-created="'+esc(j.createdAt||'')+'"><td><button type="button" class="job-select">'+esc(j.jobId)+'</button></td><td class="s-'+j.status+'">'+j.status+'</td><td>'+esc(j.phase||'')+'</td><td>'+j.attempt+'</td><td class="v-'+(j.reviewVerdict||'')+'">'+(j.reviewVerdict||'\\u2014')+'</td><td class="elapsed">'+elapsed+'</td><td>'+fmt(j.updatedAt)+'</td></tr>';
}
function selectJob(id){
  selected=(selected===id)?null:id;
  refresh();
  if(selected){loadDetail(selected);}else{document.querySelector('#detail-body').innerHTML='<p class="hint">\\u70b9\\u51fb\\u4e0a\\u65b9\\u4efb\\u52a1\\u884c\\u67e5\\u770b\\u8be6\\u60c5</p>';}
}
async function loadDetail(id){
  var body=document.querySelector('#detail-body');
  body.innerHTML='<p>\\u52a0\\u8f7d\\u4e2d\\u2026</p>';
  // Stage chain (top): 受 result.json.stages 驱动,失败/通过着色
  var result=null;
  try{result=JSON.parse(await fetch('/api/jobs/'+id+'/artifact/result.json').then(function(r){return r.text()}));}catch(e){}
  var stageHtml='';
  if(result&&result.stages&&result.stages.length){
    stageHtml+='<div class="stages">';
    result.stages.forEach(function(s,i){
      var v=s.reviewVerdict||(s.exitCode===0?(s.testExitCode===0||s.testExitCode===null?'PASS':'FAIL'):'FAIL');
      var cls=v==='PASS'?'st-pass':v==='FAIL'?'st-fail':'st-skip';
      if(i>0)stageHtml+='<span class="arrow">\\u2192</span>';
      stageHtml+='<span class="stage '+cls+'">'+esc(s.name)+' / '+esc(s.executor)+(v?' / '+v:'')+'</span>';
    });
    stageHtml+='</div>';
  }
  body.innerHTML=stageHtml+'<div class="tabs" id="detail-tabs"></div><div class="tab-panels" id="detail-panels"></div>';
  // 动态 tab 列表
  var tabs=[
    {name:'overview',label:'\\u6982\\u89c8'},
    {name:'timeline',label:'\\u9636\\u6bb5\\u65f6\\u95f4\\u7ebf'},
    {name:'executor',label:'\\u6267\\u884c\\u5668'},
    {name:'diff',label:'Diff'},
    {name:'test',label:'Test'},
    {name:'review',label:'Review'},
  ];
  var tabsEl=document.querySelector('#detail-tabs');
  var panelsEl=document.querySelector('#detail-panels');
  tabsEl.innerHTML=tabs.map(function(t,i){return '<button type="button" class="tab'+(i===0?' active':'')+'" data-tab="'+t.name+'">'+t.label+'</button>';}).join('');
  panelsEl.innerHTML=tabs.map(function(t,i){return '<div class="tab-panel'+(i===0?' active':'')+'" data-tab="'+t.name+'">\\u52a0\\u8f7d\\u4e2d\\u2026</div>';}).join('');
  tabsEl.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click',function(){
      tabsEl.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
      btn.classList.add('active');
      panelsEl.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
      panelsEl.querySelector('.tab-panel[data-tab="'+btn.dataset.tab+'"]').classList.add('active');
      loadTab(id,btn.dataset.tab,panelsEl,result);
    });
  });
  // 默认加载 overview
  loadTab(id,'overview',panelsEl,result);
}
async function loadTab(id,tab,panelsEl,result){
  var panel=panelsEl.querySelector('.tab-panel[data-tab="'+tab+'"]');
  if(!panel)return;
  panel.innerHTML='\\u52a0\\u8f7d\\u4e2d\\u2026';
  try{
    if(tab==='overview'){
      var html='';
      if(result){
        html+='<div><b>\\u72b6\\u6001\\uff1a</b>'+esc(result.status||'\\u2014')+'</div>';
        if(result.handback)html+='<pre class="art-view" style="display:block;max-height:240px">'+esc(result.handback)+'</pre>';
        if(result.evidenceArtifacts)html+='<div style="margin-top:6px;color:#888">\\u8bc1\\u636e\\u5237\\u65b0\\u5728 Diff / Test / Review \\u9009\\u9879\\u5361\\u3002</div>';
      } else {
        html='<p class="hint">\\u4efb\\u52a1\\u5c1a\\u672a\\u751f\\u6210 result.json\\u3002</p>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='timeline'){
      var tl=await fetch('/api/jobs/'+id+'/timeline').then(function(r){return r.json()});
      if(!tl.stages||!tl.stages.length){panel.innerHTML='<p class="hint">\\u65e0\\u9636\\u6bb5\\u8f6c\\u6362\\u8bb0\\u5f55\\u3002</p>';return;}
      var maxMs=Math.max.apply(null,tl.stages.map(function(s){return s.durationMs||0;}).concat([1000]));
      var rows=tl.stages.map(function(s){
        var dur=s.durationMs!=null?(s.durationMs<1000?s.durationMs+'ms':(s.durationMs/1000).toFixed(1)+'s'):'\\u8fdb\\u884c\\u4e2d';
        var w=s.durationMs?Math.max(4,Math.round((s.durationMs/maxMs)*320)):4;
        var color=s.name==='done'?'#70e090':['failed','review_failed','cancelled'].indexOf(s.name)>=0?'#ff8d8d':s.name==='running'?'#ffd166':'#5b8def';
        var label=s.phase?s.name+' / '+s.phase:s.name;
        return '<div class="timeline-row"><div class="timeline-name">'+esc(label)+'</div><div class="timeline-bar" style="width:'+w+'px;background:'+color+'"></div><div class="timeline-dur">'+dur+'</div><div class="timeline-at">'+esc((s.startedAt||'').slice(11,19))+'</div></div>';
      }).join('');
      panel.innerHTML='<div style="margin-bottom:8px;color:#888">\\u5f53\\u524d\\u9636\\u6bb5\\uff1a<b>'+esc(tl.currentStage||'\\u2014')+'</b> \\u00b7 \\u5df2\\u8dd1 '+tl.elapsedSec+'s</div>'+rows;
    }
    else if(tab==='executor'){
      var ex=await fetch('/api/jobs/'+id+'/executor').then(function(r){return r.json()});
      var pulse=ex.alive===true?'pulse-alive':ex.alive===false?'pulse-dead':'pulse-unknown';
      var html='<div class="exec-card">';
      html+='<div><div class="field-label">PID</div><div class="field-value"><span class="pulse '+pulse+'"></span>'+(ex.pid!=null?ex.pid:'\\u2014')+'</div></div>';
      html+='<div><div class="field-label">\\u8fdb\\u7a0b\\u72b6\\u6001</div><div class="field-value">'+(ex.alive===true?'\\u6d3b\\u8dc3':ex.alive===false?'\\u5df2\\u9000\\u51fa':'\\u672a\\u77e5')+'</div></div>';
      html+='<div><div class="field-label">\\u5fc3\\u8df3</div><div class="field-value">'+(ex.heartbeatAt?ex.heartbeatAt.slice(11,19)+' ('+ex.heartbeatStaleSec+'s \\u524d)':ex.heartbeatAt===null?'\\u65e0\\u6587\\u4ef6':'\\u2014')+'</div></div>';
      html+='<div><div class="field-label">\\u5df2\\u8dd1</div><div class="field-value">'+(ex.elapsedSec!=null?ex.elapsedSec+'s':'\\u2014')+'</div></div>';
      html+='</div>';
      if(ex.command)html+='<div class="cmd">'+esc(ex.command)+'</div>';
      // 增量 agent.log 拉取(默认读尾部 256KB)
      var log=await fetch('/api/jobs/'+id+'/agent.log?since=0').then(function(r){return r.json()});
      if(log.content){
        html+='<h3 style="margin:14px 0 6px;color:#9ecbff">agent.log \\u5c3e\\u90e8</h3>';
        html+='<pre class="art-view" style="display:block;max-height:240px;white-space:pre-wrap">'+esc(log.content)+'</pre>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='diff'){
      var txt=await fetch('/api/jobs/'+id+'/artifact/complete.patch').then(function(r){return r.text()});
      panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre">'+esc(txt)+'</pre>';
    }
    else if(tab==='test'){
      try{var txt=await fetch('/api/jobs/'+id+'/artifact/test.log').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
      catch(e){panel.innerHTML='<p class="hint">\\u4efb\\u52a1\\u672a\\u8fd0\\u884c\\u6d4b\\u8bd5\\u6216\\u8fd8\\u6ca1\\u6d4b\\u8bd5\\u65e5\\u5fd7\\u3002</p>';}
    }
    else if(tab==='review'){
      try{var txt=await fetch('/api/jobs/'+id+'/artifact/review.md').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
      catch(e){panel.innerHTML='<p class="hint">\\u4efb\\u52a1\\u672a\\u542f\\u7528 review \\u6216\\u5ba1\\u67e5\\u8fd8\\u5728\\u8fdb\\u884c\\u3002</p>';}
    }
  } catch(e){
    panel.innerHTML='<p class="hint">\\u52a0\\u8f7d\\u5931\\u8d25\\uff1a'+esc(e instanceof Error?e.message:String(e))+'</p>';
  }
}
document.querySelector('#jobs').addEventListener('click',function(e){
  var row=e.target.closest('tr.job');if(row)selectJob(row.dataset.id);
});
loadWorkspaces().then(refresh);
setInterval(refresh,1500);
// 每秒刷新所有行耗时(不重新拉数据,仅前端算 elapsed)
setInterval(function(){
  document.querySelectorAll('tr.job').forEach(function(row){
    var created=row.getAttribute('data-created');
    if(!created)return;
    var cell=row.querySelector('.elapsed');if(!cell)return;
    cell.textContent=fmtElapsed(created);
  });
},1000);
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
      const timeline = /^\/api\/jobs\/([^/]+)\/timeline$/.exec(url.pathname);
      if (timeline) return json(res, await buildTimeline(ws, timeline[1]));
      const executor = /^\/api\/jobs\/([^/]+)\/executor$/.exec(url.pathname);
      if (executor) return json(res, await readExecutorStatus(ws, executor[1]));
      const agentLog = /^\/api\/jobs\/([^/]+)\/agent\.log$/.exec(url.pathname);
      if (agentLog) {
        const since = Number(url.searchParams.get("since") ?? 0);
        return text(res, JSON.stringify(await readAgentLogIncremental(ws, agentLog[1], since)), "application/json; charset=utf-8");
      }
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
