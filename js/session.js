// ============ 会话管理 ============

function createSession(){
  saveDraft();
  const s={id:"s"+Date.now()+Math.random().toString(36).slice(2,7),title:"新对话",messages:[],createdAt:Date.now(),updatedAt:Date.now(),pinned:false};
  sessions.unshift(s);
  currentSessionId=s.id;
  userWantsAutoScroll=true;
  updateJumpBtn();
  saveLocal();
  saveToDisk();
  renderSessions();
  const ta=document.getElementById("input");
  if(ta){ta.value="";autoResize(ta)}
  if(typeof updateParamBtnLabel === "function") updateParamBtnLabel();
  if(typeof updateBreadcrumb === "function") updateBreadcrumb();
  return s;
}
function getCurrentSession(){return sessions.find(s=>s.id===currentSessionId)||null}
function switchSession(id){
  if(generating){setStatus("生成中，请先停止",true);return;}
  saveDraft();
  currentSessionId=id;
  userWantsAutoScroll=true;
  updateJumpBtn();
  renderSessions();
  renderMessages();
  restoreDraft();
  if(typeof updateParamBtnLabel === "function") updateParamBtnLabel();
  if(typeof updateBreadcrumb === "function") updateBreadcrumb();
}
function deleteSession(id,ev){
  ev.stopPropagation();if(!confirm("确定删除？"))return;
  // 处理分支：如果删的是父会话，子会话的 parentSessionId 断链成为根
  const children = sessions.filter(s => s.parentSessionId === id);
  children.forEach(c => { c.parentSessionId = null; delete c.branchPointIdx; });
  sessions=sessions.filter(s=>s.id!==id);delete drafts[id];saveLocal();
  if(currentSessionId===id)currentSessionId=sessions[0]?.id||null;
  saveToDisk();renderSessions();renderMessages();restoreDraft();
  if(typeof updateParamBtnLabel === "function") updateParamBtnLabel();
  if(typeof updateBreadcrumb === "function") updateBreadcrumb();
}
function togglePinSession(id,ev){ev.stopPropagation();const s=sessions.find(x=>x.id===id);if(!s)return;s.pinned=!s.pinned;s.updatedAt=Date.now();saveLocal();saveToDisk();renderSessions();}
function startRenameSession(id){
  const el=document.querySelector(`.session-item[data-id="${id}"]`);if(!el)return;
  const titleSpan=el.querySelector(".session-title");if(!titleSpan)return;
  const s=sessions.find(x=>x.id===id);if(!s)return;
  const inp=document.createElement("input");inp.type="text";inp.className="session-rename-input";inp.value=s.title||"";titleSpan.replaceWith(inp);inp.focus();inp.select();
  let done=false;const finish=(saveIt)=>{if(done)return;done=true;if(saveIt){const v=inp.value.trim();if(v){s.title=v;s.updatedAt=Date.now();saveLocal();saveToDisk()}}renderSessions();if(typeof updateBreadcrumb === "function") updateBreadcrumb();};
  inp.onclick=(e)=>e.stopPropagation();inp.ondblclick=(e)=>e.stopPropagation();inp.onblur=()=>finish(true);
  inp.onkeydown=(e)=>{if(e.key==="Enter"){e.preventDefault();finish(true)}else if(e.key==="Escape"){e.preventDefault();finish(false)}};
}
function sessionMatches(s,q){if(!q)return true;if((s.title||"").toLowerCase().includes(q))return true;for(const m of (s.messages||[])){if(m.compare){for(const c of m.compare){if((c.content||"").toLowerCase().includes(q))return true;if((c.thinking||"").toLowerCase().includes(q))return true}}else{if((m.content||"").toLowerCase().includes(q))return true;if((m.thinking||"").toLowerCase().includes(q))return true}}return false;}
function sessionHitCount(s,q){if(!q)return 0;let n=0;for(const m of (s.messages||[])){if(m.compare){for(const c of m.compare){if((c.content||"").toLowerCase().includes(q))n++}}else{if((m.content||"").toLowerCase().includes(q))n++}}return n;}

async function jumpToSearchHit(sessionId,query){
  if(generating)return;
  if(sessionId!==currentSessionId){switchSession(sessionId);await new Promise(r=>setTimeout(r,120));}
  userWantsAutoScroll=false;updateJumpBtn();
  const s=getCurrentSession();if(!s)return;
  const q=query.toLowerCase();
  for(let i=0;i<s.messages.length;i++){
    const m=s.messages[i];let text="";
    if(m.compare)text=m.compare.map(c=>(c.content||"")+(c.thinking||"")).join(" ");
    else text=(m.content||"")+(m.thinking||"");
    if(text.toLowerCase().includes(q)){
      const wrap=document.querySelector(`.msg-wrap[data-idx="${i}"]`);
      if(wrap){wrap.scrollIntoView({behavior:"smooth",block:"center"});wrap.classList.add("search-hit");setTimeout(()=>wrap.classList.remove("search-hit"),3200);}
      return;
    }
  }
}

// ============ 分支面包屑 ============

function updateBreadcrumb(){
  const bar = document.getElementById("breadcrumbBar");
  if (!bar) return;
  const s = getCurrentSession();
  if (!s) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const chain = getSessionChain(s.id);
  if (chain.length <= 1) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = chain.map((item, i) => {
    const isCurrent = i === chain.length - 1;
    const cls = isCurrent ? "breadcrumb-item current" : "breadcrumb-item";
    const sep = i > 0 ? '<span class="breadcrumb-sep">›</span>' : '';
    const title = item.title || "对话";
    return `${sep}<span class="${cls}" data-id="${item.id}" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`;
  }).join("");
  bar.querySelectorAll(".breadcrumb-item").forEach(el => {
    el.onclick = () => {
      if (el.classList.contains("current")) return;
      switchSession(el.dataset.id);
    };
  });
}