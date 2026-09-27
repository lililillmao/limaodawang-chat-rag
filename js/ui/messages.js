// ============ 消息渲染 + 消息导航 + 引用 + 朗读 ============

function contextTokens(s){if(!s)return 0;let t=0;const sys=getActiveSystemPrompt();if(sys)t+=estimateTokens(sys);for(const m of s.messages){if(m.isSummary){t+=estimateTokens(m.content);continue}if(m.compare){for(const c of m.compare)t+=estimateTokens(c.content)+estimateTokens(c.thinking||"")}else t+=estimateTokens(m.content)+estimateTokens(m.thinking||"")}return t}
function updateCtxInfo(){
  const s=getCurrentSession();
  const used=contextTokens(s);
  const max=getEffectiveParams().num_ctx||8192;
  const pct=Math.round(used/max*100);
  const el=document.getElementById("ctxInfo");
  if(!el)return;
  el.textContent=`≈ ${used}/${max} (${pct}%)`;
  el.style.color=pct>85?"#e34b4b":pct>60?"#f0a020":"var(--text-dim)";
}

function toggleStar(idx) {
    const s = getCurrentSession();
    if (!s || !s.messages[idx]) return;
    s.messages[idx].starred = !s.messages[idx].starred;
    s.updatedAt = Date.now();
    saveLocal();
    saveToDisk();
    renderMessages();
    renderSessions();
}

function quoteMessage(idx) {
    const s = getCurrentSession();
    if (!s || !s.messages[idx]) return;
    const m = s.messages[idx];
    let text = m.content || "";
    if (m.compare) {
        text = m.compare.map(c => c.content || "").join("\n");
    }
    quoteState = { text: text.slice(0, 500), idx: idx };
    renderQuotePreview();
    const input = document.getElementById("input");
    if (input) input.focus();
}

function clearQuote() {
    quoteState = null;
    renderQuotePreview();
}

function renderQuotePreview() {
    const box = document.getElementById("quotePreview");
    if (!box) return;
    if (!quoteState) {
        box.innerHTML = "";
        box.classList.remove("show");
        return;
    }
    box.classList.add("show");
    box.innerHTML = `<div class="quote-bar"><div class="quote-inner"><div class="quote-head">引用消息</div><div class="quote-text">${escapeHtml(quoteState.text)}</div></div><button class="quote-close">×</button></div>`;
    const closeBtn = box.querySelector(".quote-close");
    if (closeBtn) closeBtn.onclick = clearQuote;
}

function speakMessage(text, btn) {
    if (!text) return;
    if (!window.speechSynthesis) { alert("你的浏览器不支持语音朗读。"); return; }
    if (speakingBtn === btn) {
        window.speechSynthesis.cancel();
        btn.classList.remove("speaking");
        speakingBtn = null;
        return;
    }
    window.speechSynthesis.cancel();
    if (speakingBtn) speakingBtn.classList.remove("speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    utter.onend = () => { btn.classList.remove("speaking"); speakingBtn = null; };
    utter.onerror = () => { btn.classList.remove("speaking"); speakingBtn = null; };
    speakingBtn = btn;
    btn.classList.add("speaking");
    window.speechSynthesis.speak(utter);
}

function switchVersion(m, dir) {
    if (!m.versions || m.versions.length <= 1) return;
    const cur = m.currentVersion || 0;
    const next = Math.max(0, Math.min(m.versions.length - 1, cur + dir));
    if (next === cur) return;
    m.currentVersion = next;
    const v = m.versions[next];
    m.model = v.model;
    m.content = v.content;
    m.thinking = v.thinking || "";
    m.time = v.time;
    m.speed = v.speed;
    renderMessages();
    saveLocal();
    saveToDisk();
}
function deleteMessage(idx) {
    if (!confirm("确定要删除这条消息吗？")) return;
    const s = getCurrentSession();
    if (!s || !s.messages[idx]) return;
    s.messages.splice(idx, 1);
    s.updatedAt = Date.now();
    saveLocal();
    saveToDisk();
    renderMessages();
    updateCtxInfo();
}

function streamUpdate(){
  const wrap=document.querySelector('.msg-wrap[data-last="1"]');
  if(!wrap){renderMessages();return}
  const s=getCurrentSession();const m=s.messages[s.messages.length-1];
  const now=Date.now();
  if(now-lastStreamSaveTs>1500){lastStreamSaveTs=now;try{saveLocal()}catch(e){}}
  if(m.groupId){renderMessages();return}
  const {thinking,content}=getThinkAndContent(m);
  const oldBox=wrap.querySelector(".think-box");
  const userToggled=oldBox&&oldBox.dataset.userToggled==="1";
  const wasOpen=oldBox&&oldBox.classList.contains("open");
  wrap.innerHTML=buildMessageInner(m,true,s.messages.length-1);
  postRender(wrap);updateCtxInfo();
  const newBox=wrap.querySelector(".think-box");
  if(newBox){
    if(userToggled){newBox.dataset.userToggled="1";if(wasOpen)newBox.classList.add("open")}
    else{if(generating&&thinking&&!content)newBox.classList.add("open");else newBox.classList.remove("open")}
    const metaEl=newBox.querySelector(".think-meta");
    if(metaEl)metaEl.textContent=(generating&&thinking&&!content)?"思考中…":(thinking.length+" 字");
    newBox.querySelector(".think-head").onclick=()=>{newBox.classList.toggle("open");newBox.dataset.userToggled="1"};
  }
  bindMsgActions(wrap,m,s.messages.length-1);
  if(userWantsAutoScroll)scrollToBottom();
}

function bindMsgActions(wrap,m,idx){
  const cb=wrap.querySelector(".continue-btn");if(cb)cb.onclick=continueGeneration;
  const rb=wrap.querySelector(".regen-btn");if(rb)rb.onclick=regenerateLast;
  const eb=wrap.querySelector(".edit-btn");if(eb)eb.onclick=()=>startEditMessage(idx);
  const bb=wrap.querySelector(".branch-btn");if(bb)bb.onclick=()=>branchFromMessage(idx);
  const copyBtn=wrap.querySelector(".copy-btn");
  if(copyBtn)copyBtn.onclick=()=>{let textToCopy=m.role==="user"?m.content:(getThinkAndContent(m).content||"");textToCopy=replaceEmo(textToCopy);copyText(textToCopy,copyBtn)};
  const saveBtn=wrap.querySelector(".edit-save");if(saveBtn)saveBtn.onclick=()=>saveEditMessage(idx);
  const cancelBtn=wrap.querySelector(".edit-cancel");if(cancelBtn)cancelBtn.onclick=cancelEdit;
  const exBtn=wrap.querySelector(".export-one-btn");
  if(exBtn)exBtn.onclick=()=>{const {thinking,content}=getThinkAndContent(m);exportSingleAnswer({model:m.model,content,thinking,skillName:m.skillName})};
  const starBtn=wrap.querySelector(".star-btn");if(starBtn)starBtn.onclick=()=>toggleStar(idx);
  const delBtn=wrap.querySelector(".del-btn");if(delBtn)delBtn.onclick=()=>deleteMessage(idx);
  const quoteBtn=wrap.querySelector(".quote-btn");if(quoteBtn)quoteBtn.onclick=()=>quoteMessage(idx);
  const speakBtn=wrap.querySelector(".speak-btn");if(speakBtn)speakBtn.onclick=()=>{const {content}=getThinkAndContent(m);speakMessage(content,speakBtn)};
  const vp=wrap.querySelector(".ver-prev");if(vp)vp.onclick=()=>switchVersion(m,-1);
  const vn=wrap.querySelector(".ver-next");if(vn)vn.onclick=()=>switchVersion(m,1);
  wrap.querySelectorAll(".cmp-copy").forEach((b,i)=>{if(m.compare&&m.compare[i])b.onclick=()=>{let t=replaceEmo(m.compare[i].content||"");copyText(t,b)};});
  wrap.querySelectorAll(".cmp-export").forEach((b,i)=>{if(m.compare&&m.compare[i]){const c=m.compare[i];b.onclick=()=>{const {thinking,content}=getThinkAndContent(c);exportSingleAnswer({model:c.model,content,thinking,skillName:m.skillName})};}});
  wrap.querySelectorAll(".think-box").forEach(tb=>{const head=tb.querySelector(".think-head");if(head&&!head.onclick)head.onclick=()=>{tb.classList.toggle("open");tb.dataset.userToggled="1"};});
  wrap.querySelectorAll(".rag-source-head").forEach(head=>{if(head&&!head.onclick)head.onclick=()=>head.parentElement.classList.toggle("open");});

  // RAG 引用相关按钮
  wrap.querySelectorAll(".rag-toggle-btn").forEach(btn=>{
    btn.onclick=()=>{
      const item = btn.closest(".rag-source-item");
      if(!item) return;
      const preview = item.querySelector(".rag-source-preview");
      const full = item.querySelector(".rag-source-full");
      if(!preview || !full) return;
      const isExpanded = full.style.display !== "none";
      if(isExpanded){
        full.style.display = "none";
        preview.style.display = "";
        btn.textContent = "展开全文";
      }else{
        full.style.display = "";
        preview.style.display = "none";
        btn.textContent = "收起";
      }
    };
  });
  wrap.querySelectorAll(".rag-copy-btn").forEach(btn=>{
    btn.onclick=()=>{
      const item = btn.closest(".rag-source-item");
      if(!item) return;
      const full = item.querySelector(".rag-source-full");
      const text = full ? full.textContent : "";
      copyText(text, btn);
    };
  });
  wrap.querySelectorAll(".rag-open-btn").forEach(btn=>{
    btn.onclick=()=>{
      const path = btn.dataset.path;
      if(path) openLocalFolder(path);
    };
  });
}

function renderAiBody(m,isStreamingLast){
  const isStreaming=isStreamingLast&&generating;
  const {thinking,content}=getThinkAndContent(m);
  const openCls=(isStreaming&&!content)?" open":"";
  const meta=(isStreaming&&!content)?'<span class="think-meta">思考中…</span>':(thinking?`<span class="think-meta">${thinking.length} 字</span>`:"");
  let html="";
  if(thinking){html+=`<div class="think-box${openCls}"><div class="think-head"><span class="think-arrow"></span><span class="think-label">深度思考</span>${meta}</div><div class="think-content">${escapeHtml(thinking)}</div></div>`;}
  const cursor=(isStreamingLast&&generating)?'<span class="cursor"></span>':"";
  html+=`<div class="msg-content">${renderMarkdown(content)}${cursor}</div>`;
  return html;
}

// ============ RAG 引用卡片渲染 ============
function buildRagSourcesHtml(sources){
  if(!sources || !sources.length) return "";

  const items = sources.map((src, i) => {
    // ★ 改用 cosine 距离：distance 范围 0~2，映射为百分比
    // distance=0 → 100%，distance=1 → 50%，distance=2 → 0%
    let scoreHtml = "";
    if(src.distance != null){
      let score = Math.round((1 - src.distance) * 100);
      if (score < 0) score = 0;
      if (score > 100) score = 100;
      const cls = score >= 80 ? "score-high" : score >= 60 ? "score-mid" : "score-low";
      scoreHtml = `<span class="rag-source-score ${cls}" title="相关度（cosine distance=${src.distance.toFixed(3)}）">相关度 ${score}%</span>`;
    }
    const preview = src.content.length > 150 ? src.content.slice(0, 150) + "…" : src.content;
    const isSafety = src.isSafety;
    const sourceName = isSafety ? "🛡️ 安全兜底" : `📄 ${escapeHtml(src.name)}`;
    const openBtnHtml = (!isSafety && src.fullPath)
      ? `<button class="rag-src-btn rag-open-btn" data-path="${escapeHtml(src.fullPath)}" title="打开文件所在目录">📂 打开目录</button>`
      : "";

    return `<div class="rag-source-item" data-rag-idx="${i}">
      <div class="rag-source-head-row">
        <span class="rag-source-name" title="${escapeHtml(src.fullPath || src.name)}">${sourceName}</span>
        ${scoreHtml}
      </div>
      <div class="rag-source-text rag-source-preview">${escapeHtml(preview)}</div>
      <div class="rag-source-text rag-source-full" style="display:none">${escapeHtml(src.content)}</div>
      <div class="rag-source-actions">
        <button class="rag-src-btn rag-toggle-btn">展开全文</button>
        <button class="rag-src-btn rag-copy-btn" title="复制这段内容">📋 复制</button>
        ${openBtnHtml}
      </div>
    </div>`;
  }).join("");

  return `<div class="rag-source-box"><div class="rag-source-head"><span class="rag-arrow"></span><span class="rag-icon">📚</span><span>已引用 ${sources.length} 个知识库片段</span></div><div class="rag-source-list">${items}</div></div>`;
}

function buildMessageInner(m,isStreamingLast,idx){
  const isUser=m.role==="user";
  const isEditing=isUser&&idx===editingMsgIndex;
  if(isEditing){return `<div><div class="msg-role">✏️ 编辑消息</div><textarea class="edit-area">${escapeHtml(m.content)}</textarea><div class="edit-actions"><button class="edit-cancel">取消</button><button class="edit-save primary">保存并重新发送</button></div></div>`;}
  if(m.isSummary){return `<div class="msg"><div class="avatar ai">📝</div><div class="msg-body"><div class="msg-role">上下文摘要（已压缩） ${formatTime(m.time)}<span class="compress-info">压缩后节省上下文</span></div><div class="msg-content">${renderMarkdown(m.content)}</div></div></div>`;}
  const timeStr=formatTime(m.time);const timeHtml=timeStr?`<span class="msg-time">${timeStr}</span>`:"";
  const starredCls=m.starred?" starred":"";
  const starBtn=`<button class="msg-fbtn star-btn${starredCls}" title="${m.starred?"取消收藏":"收藏"}">⭐</button>`;
  const delBtn=`<button class="msg-fbtn del-btn" title="删除这条消息">🗑</button>`;
  const quoteBtn=`<button class="msg-fbtn quote-btn" title="引用这条消息">💬</button>`;
  if(isUser){
    const floatBtns=`<div class="msg-float"><button class="msg-fbtn copy-btn" title="复制">📋</button><button class="msg-fbtn edit-btn" title="编辑">✏️</button>${quoteBtn}${starBtn}${delBtn}</div>`;
    return `${floatBtns}<div class="msg"><div class="avatar user">你</div><div class="msg-body"><div class="msg-role">你 ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div><div class="msg-content">${renderMarkdown(m.content)}</div></div></div>`;
  }
  if(m.compare){
    const c0=m.compare[0],c1=m.compare[1];
    const t0=estimateTokens(c0.content+(c0.thinking||"")),t1=estimateTokens(c1.content+(c1.thinking||""));
    const tokensHtml=`<span class="msg-tokens">≈ ${t0} / ${t1} token</span>`;
    const colHtml=(c)=>{const {thinking,content}=getThinkAndContent(c);const thinkHtml=thinking?`<div class="think-box"><div class="think-head"><span class="think-arrow"></span><span class="think-label">深度思考</span><span class="think-meta">${thinking.length} 字</span></div><div class="think-content">${escapeHtml(thinking)}</div></div>`:"";return `<div class="compare-col"><div class="compare-head"><span class="dot"></span>${escapeHtml(c.model)}<span style="margin-left:auto;display:flex;gap:4px"><button class="msg-fbtn cmp-copy" style="width:24px;height:24px;font-size:11px" title="复制这条回答">📋</button><button class="msg-fbtn cmp-export" style="width:24px;height:24px;font-size:11px" title="导出这条回答 (.md)">↧</button></span></div>${thinkHtml}<div class="msg-content">${renderMarkdown(content)}</div></div>`;};
    const floatBtns=`<div class="msg-float">${quoteBtn}${starBtn}${delBtn}</div>`;
    const skillBadge = m.skillName ? `<span class="msg-skill" title="本次回答使用的 Skill">🧩 ${escapeHtml(m.skillName)}</span>` : "";
    return `${floatBtns}<div class="msg"><div class="avatar ai">⚖️</div><div class="msg-body"><div class="msg-role">模型对比 ${tokensHtml} ${skillBadge} ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div><div class="msg-compare">${colHtml(c0)}${colHtml(c1)}</div></div></div>`;
  }
  const tokens=estimateTokens(m.content+(m.thinking||""));
  let tokenInfo=tokens?`≈ ${tokens} token`:"";
  if(m.speed&&m.speed>0)tokenInfo+=` · ${m.speed.toFixed(1)} tok/s`;
  const msgTokens=tokenInfo?`<span class="msg-tokens">${tokenInfo}</span>`:"";
  let versionNav="";
  if(m.versions&&m.versions.length>1){
    const cur=(m.currentVersion||0)+1;const total=m.versions.length;
    versionNav=`<span class="version-nav"><button class="ver-prev" title="上一个版本" ${m.currentVersion<=0?"disabled":""}>◀</button><span>${cur} / ${total}</span><button class="ver-next" title="下一个版本" ${m.currentVersion>=total-1?"disabled":""}>▶</button></span>`;
  }

  const ragHtml = buildRagSourcesHtml(m.ragSources);

  const body=renderAiBody(m,isStreamingLast);
  let actions="";
  if(isStreamingLast&&!generating&&(m.content||m.thinking)){
    actions=`<div class="msg-actions"><button class="msg-action continue-btn" title="继续写">▶ 继续生成</button><button class="msg-action regen-btn" title="重新生成">🔄 重新生成</button><button class="msg-action branch-btn" title="从这一刻创建分支">🌿 分叉</button></div>`;
  }
  const floatBtns=`<div class="msg-float"><button class="msg-fbtn copy-btn" title="复制">📋</button><button class="msg-fbtn speak-btn" title="朗读这条回答">🔊</button>${quoteBtn}${starBtn}${delBtn}<button class="msg-fbtn export-one-btn" title="导出这条回答 (.md)">↧</button></div>`;
  const skillBadge = m.skillName ? `<span class="msg-skill" title="本次回答使用的 Skill">🧩 ${escapeHtml(m.skillName)}</span>` : "";
  return `${floatBtns}<div class="msg"><div class="avatar ai">AI</div><div class="msg-body"><div class="msg-role">${escapeHtml(m.model||cfg.model||"AI")} ${skillBadge} ${msgTokens} ${versionNav} ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div>${body}${ragHtml}${actions}</div></div>`;
}

function getMsgPreview(m){if(!m)return"";if(m.isSummary)return"【摘要】"+(m.content||"").slice(0,60);if(m.compare){const t=(m.compare[0]&&m.compare[0].content)||"";return"【对比】"+replaceEmo(t).slice(0,60);}if(m.role==="user")return"你："+replaceEmo(m.content||"").slice(0,60);return"AI："+replaceEmo(m.content||"").slice(0,60);}
function renderMsgNav(){
  const nav=document.getElementById("msgNav");const s=getCurrentSession();nav.innerHTML="";navTicks=[];
  if(navObserver){navObserver.disconnect();navObserver=null}
  if(!s||!s.messages.length){nav.classList.remove("show");return}
  if(s.messages.length<3){nav.classList.remove("show");return}
  nav.classList.add("show");
  s.messages.forEach((m,i)=>{
    const tick=document.createElement("div");let cls="nav-tick";
    if(m.isSummary)cls+=" summary";else if(m.compare)cls+=" compare";else if(m.role==="user")cls+=" user";else cls+=" ai";
    tick.className=cls;tick.dataset.idx=i;tick.title="";
    tick.onclick=()=>{const wrap=document.querySelector(`.msg-wrap[data-idx="${i}"]`);if(wrap){userWantsAutoScroll=false;updateJumpBtn();wrap.scrollIntoView({behavior:"smooth",block:"start"})}};
    tick.onmouseenter=(e)=>{
      const tip=document.getElementById("navTip");const text=getMsgPreview(m);if(!text){tip.classList.remove("show");return}
      tip.textContent=text;const rect=tick.getBoundingClientRect();tip.style.left=Math.max(8,rect.left-tip.offsetWidth-8)+"px";tip.style.top=Math.max(8,rect.top+rect.height/2-14)+"px";tip.classList.add("show");
      requestAnimationFrame(()=>{const r2=tick.getBoundingClientRect();tip.style.left=Math.max(8,r2.left-tip.offsetWidth-10)+"px";tip.style.top=Math.max(8,Math.min(window.innerHeight-40,r2.top+r2.height/2-14))+"px";});
    };
    tick.onmouseleave=()=>{document.getElementById("navTip").classList.remove("show")};
    nav.appendChild(tick);navTicks.push(tick);
  });
  setupNavObserver();
}
function setupNavObserver(){
  if(navObserver){navObserver.disconnect()}if(!navTicks.length)return;
  const root=document.getElementById("messages");
  navObserver=new IntersectionObserver((entries)=>{entries.forEach(en=>{const idx=en.target.dataset.idx;if(idx===undefined)return;const tick=navTicks[parseInt(idx)];if(!tick)return;if(en.isIntersecting)tick.classList.add("active");else tick.classList.remove("active");});},{root:root,threshold:0.3});
  document.querySelectorAll("#messages .msg-wrap").forEach(w=>navObserver.observe(w));
}
function updateNavActiveOnScroll(){
  if(!navTicks.length)return;let anyActive=false;
  for(const t of navTicks){if(t.classList.contains("active")){anyActive=true;break}}
  if(anyActive)return;
  const box=document.getElementById("messages");const wraps=box.querySelectorAll(".msg-wrap");const top=box.getBoundingClientRect().top;let best=-1,bestDist=Infinity;
  wraps.forEach(w=>{const r=w.getBoundingClientRect();const d=Math.abs(r.top-top);if(d<bestDist){bestDist=d;best=parseInt(w.dataset.idx)}});
  navTicks.forEach(t=>t.classList.remove("active"));if(best>=0&&navTicks[best])navTicks[best].classList.add("active");
}

function renderMessages(){
  const box=document.getElementById("messages");const s=getCurrentSession();
  if(!s||!s.messages.length){box.innerHTML=`<div style="text-align:center;color:var(--text-dim);margin-top:80px;font-size:15px;"><div style="font-size:40px;margin-bottom:10px">💬</div>开始一个新的对话吧</div>`;renderMsgNav();updateCtxInfo();return;}
  box.innerHTML="";const rendered=new Set();
  s.messages.forEach((m,i)=>{
    if(rendered.has(i))return;
    const wrap=document.createElement("div");wrap.className="msg-wrap";wrap.dataset.idx=i;
    const isLast=i===s.messages.length-1;if(isLast)wrap.dataset.last="1";
    if(m.isSummary){wrap.classList.add("summary");wrap.innerHTML=buildMessageInner(m,false,i);}
    else if(m.groupId&&m.role==="assistant"){
      const nextIdx=i+1;
      if(nextIdx<s.messages.length&&s.messages[nextIdx].groupId===m.groupId){
        rendered.add(nextIdx);wrap.classList.add("wide");
        const tmp={role:"assistant",compare:[{model:m.model,content:m.content,thinking:m.thinking},{model:s.messages[nextIdx].model,content:s.messages[nextIdx].content,thinking:s.messages[nextIdx].thinking}],time:m.time,starred:m.starred,skillName:m.skillName};
        wrap.innerHTML=buildMessageInner(tmp,false,i);
      }else{wrap.innerHTML=buildMessageInner(m,isLast,i);}
    }else{wrap.innerHTML=buildMessageInner(m,isLast,i);}
    box.appendChild(wrap);postRender(wrap);bindMsgActions(wrap,m,i);
  });
  if(userWantsAutoScroll)scrollToBottom();renderMsgNav();updateCtxInfo();
}
function scrollToBottom(){const box=document.getElementById("messages");box.scrollTop=box.scrollHeight}
function updateJumpBtn(){document.getElementById("jumpBtn").classList.toggle("show",!userWantsAutoScroll)}
function bindScrollWatcher(){
  const box=document.getElementById("messages");
  box.addEventListener("scroll",()=>{const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;userWantsAutoScroll=nearBottom;updateJumpBtn();updateNavActiveOnScroll();});
  document.getElementById("jumpBtn").onclick=()=>{userWantsAutoScroll=true;updateJumpBtn();scrollToBottom()};
}