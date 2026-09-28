// ============ 侧栏会话列表 ============

function renderSessions(){
  const box=document.getElementById("sessionList");const q=searchQuery.trim().toLowerCase();
  let list=sessions.filter(s=>sessionMatches(s,q));if(starFilter)list=list.filter(s=>(s.messages||[]).some(m=>m.starred));
  list.sort((a,b)=>{const pa=a.pinned?1:0,pb=b.pinned?1:0;if(pa!==pb)return pb-pa;return (b.updatedAt||0)-(a.updatedAt||0);});
  if(!list.length){box.innerHTML=q?'<div style="padding:14px;font-size:13px;color:var(--text-dim)">没有匹配的对话</div>':'<div style="padding:14px;font-size:13px;color:var(--text-dim)">暂无对话</div>';return;}
  box.innerHTML=list.map(s=>{
    const hit=(q&&!(s.title||"").toLowerCase().includes(q))?sessionHitCount(s,q):0;
    const hitHtml=hit>0?`<span class="session-hit" title="正文中匹配 ${hit} 条">正文×${hit}</span>`:"";
    const hasStar=(s.messages||[]).some(m=>m.starred);const starMark=hasStar?'<span class="session-star" title="有收藏消息">★</span>':'';
    const pinCls=s.pinned?" pinned":"";
    return `<div class="session-item ${s.id===currentSessionId?"active":""}" data-id="${s.id}" title="双击标题重命名 · 单击打开"><span class="session-pin${pinCls}" data-pin="${s.id}" title="${s.pinned?'取消置顶':'置顶对话'}">📌</span><span class="session-title">${escapeHtml(s.title)}${hitHtml}${starMark}</span><span class="session-del" data-del="${s.id}">×</span></div>`;
  }).join("");
  box.querySelectorAll(".session-item").forEach(el=>{el.onclick=()=>{switchSession(el.dataset.id);if(q)setTimeout(()=>jumpToSearchHit(el.dataset.id,q),150)};el.ondblclick=(e)=>{e.stopPropagation();startRenameSession(el.dataset.id)};});
  box.querySelectorAll(".session-pin").forEach(el=>el.onclick=(ev)=>togglePinSession(el.dataset.pin,ev));
  box.querySelectorAll(".session-del").forEach(el=>el.onclick=(ev)=>deleteSession(el.dataset.del,ev));
}