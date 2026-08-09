console.log('cbx-ui: script start, page loaded at', new Date().toISOString());
var allWorkspaces=[];
var currentWorkspace=null;
var selected=null;
function rowAttr(id){return String(id).replace(/[^\w-]/g,function(c){return'\\\\'+c})}
function totalJobs(w){return Object.values(w.jobsByStatus||{}).reduce(function(a,b){return a+b;},0)}
function fmt(iso){try{return new Date(iso).toLocaleTimeString()}catch(e){return iso}}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function cbxFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{});
  if(window.CBX_TOKEN)opts.headers['Authorization']='Bearer '+window.CBX_TOKEN;
  return fetch(url,opts);
}
async function refresh(){
  var ws=encodeURIComponent(currentWorkspace||'');
  var jobs=await cbxFetch('/api/jobs?workspace='+ws).then(function(r){return r.json()});
  var q=await cbxFetch('/api/queue?workspace='+ws).then(function(r){return r.json()});
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
  console.log('cbx-ui: loadWorkspaces called');
  try{
    var response=await cbxFetch('/api/workspaces');
    console.log('cbx-ui: fetch status', response.status);
    if(!response.ok) throw new Error('HTTP '+response.status);
    var data=await response.json();
    console.log('cbx-ui: got data', data.workspaces ? data.workspaces.length+' workspaces' : 'NO workspaces');
    allWorkspaces=data.workspaces||[];
    currentWorkspace=data.default;
  }catch(e){
    console.error('cbx-ui: loadWorkspaces error', e);
    document.querySelector('#ws-name').textContent='fetch error: '+(e instanceof Error?e.message:String(e));
    return;
  }
  var qs=new URLSearchParams(location.search);
  var req=qs.get('workspace');
  if(req&&allWorkspaces.some(function(w){return w.path===req;}))currentWorkspace=req;
  console.log('cbx-ui: calling renderWorkspaces, currentWorkspace=', currentWorkspace);
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
  try{result=JSON.parse(await cbxFetch('/api/jobs/'+id+'/artifact/result.json').then(function(r){return r.text()}));}catch(e){}
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
      var tl=await cbxFetch('/api/jobs/'+id+'/timeline').then(function(r){return r.json()});
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
      var ex=await cbxFetch('/api/jobs/'+id+'/executor').then(function(r){return r.json()});
      var pulse=ex.alive===true?'pulse-alive':ex.alive===false?'pulse-dead':'pulse-unknown';
      var html='<div class="exec-card">';
      html+='<div><div class="field-label">PID</div><div class="field-value"><span class="pulse '+pulse+'"></span>'+(ex.pid!=null?ex.pid:'\\u2014')+'</div></div>';
      html+='<div><div class="field-label">\\u8fdb\\u7a0b\\u72b6\\u6001</div><div class="field-value">'+(ex.alive===true?'\\u6d3b\\u8dc3':ex.alive===false?'\\u5df2\\u9000\\u51fa':'\\u672a\\u77e5')+'</div></div>';
      html+='<div><div class="field-label">\\u5fc3\\u8df3</div><div class="field-value">'+(ex.heartbeatAt?ex.heartbeatAt.slice(11,19)+' ('+ex.heartbeatStaleSec+'s \\u524d)':ex.heartbeatAt===null?'\\u65e0\\u6587\\u4ef6':'\\u2014')+'</div></div>';
      html+='<div><div class="field-label">\\u5df2\\u8dd1</div><div class="field-value">'+(ex.elapsedSec!=null?ex.elapsedSec+'s':'\\u2014')+'</div></div>';
      html+='</div>';
      if(ex.command)html+='<div class="cmd">'+esc(ex.command)+'</div>';
      // 增量 agent.log 拉取(默认读尾部 256KB)
      var log=await cbxFetch('/api/jobs/'+id+'/agent.log?since=0').then(function(r){return r.json()});
      if(log.content){
        html+='<h3 style="margin:14px 0 6px;color:#9ecbff">agent.log \\u5c3e\\u90e8</h3>';
        html+='<pre class="art-view" style="display:block;max-height:240px;white-space:pre-wrap">'+esc(log.content)+'</pre>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='diff'){
      var txt=await cbxFetch('/api/jobs/'+id+'/artifact/complete.patch').then(function(r){return r.text()});
      panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre">'+esc(txt)+'</pre>';
    }
    else if(tab==='test'){
      try{var txt=await cbxFetch('/api/jobs/'+id+'/artifact/test.log').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
      catch(e){panel.innerHTML='<p class="hint">\\u4efb\\u52a1\\u672a\\u8fd0\\u884c\\u6d4b\\u8bd5\\u6216\\u8fd8\\u6ca1\\u6d4b\\u8bd5\\u65e5\\u5fd7\\u3002</p>';}
    }
    else if(tab==='review'){
      try{var txt=await cbxFetch('/api/jobs/'+id+'/artifact/review.md').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
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
	var es=new EventSource('/events?token='+encodeURIComponent(window.CBX_TOKEN||''));
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
