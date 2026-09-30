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
    // ★ 修复：切版本时要把该版本自己的工具调用、工具结果与 token 用量一起还原。
    //   1.23 引入工具调用后，版本栈只存了 model/content/thinking/time/speed，
    //   导致切回旧版本时：旧版本的工具卡片要么丢失、要么显示成新版本的工具调用；
    //   同时 promptTokens/completionTokens 仍留着新版本的值，误导费用徽章与统计。
    const v = m.versions[next];
    m.currentVersion = next;
    m.model = v.model;
    m.content = v.content;
    m.thinking = v.thinking || "";
    m.time = v.time;
    m.speed = v.speed;
    // 有记录就用该版本的，没有就置空（不能沿用上一个版本的值）
    m.toolCalls = Array.isArray(v.toolCalls) ? v.toolCalls : null;
    m.toolResults = Array.isArray(v.toolResults) ? v.toolResults : null;
    m.promptTokens = toTokenNum(v.promptTokens);
    m.completionTokens = toTokenNum(v.completionTokens);
    m.genTime = v.genTime || 0;
    m.usageSource = v.usageSource || null;
    renderMessages();
    saveLocal();
    saveToDisk();
}
// ★ 修复：删除消息时，如果是"对比中间态"（一对同 groupId 的 assistant 占位消息），
//   必须成对删除。1.23 之前的实现里，这对消息被合并渲染成一张对比卡片，
//   但卡片按钮绑定的是【左栏】那条，于是点 🗑 只删掉模型 A 的回答，
//   模型 B 的回答原地"漂移"成孤立消息 —— 既删错了对象，又把界面弄乱。
//   注意：正常完成的对比消息是单条带 m.compare 的，没有 groupId，不受影响。
function deleteMessage(idx) {
    const s = getCurrentSession();
    if (!s || !s.messages[idx]) return;
    const m = s.messages[idx];
    const gid = m.groupId;
    if (gid) {
        const group = s.messages.filter(x => x.groupId === gid);
        if (group.length > 1) {
            if (!confirm(`确定要删除这一组对比回答吗？（共 ${group.length} 条）`)) return;
            s.messages = s.messages.filter(x => x.groupId !== gid);
            s.updatedAt = Date.now();
            saveLocal();
            saveToDisk();
            renderMessages();
            updateCtxInfo();
            setStatus(`已删除该组对比回答（${group.length} 条）`);
            return;
        }
    }
    if (!confirm("确定要删除这条消息吗？")) return;
    s.messages.splice(idx, 1);
    s.updatedAt = Date.now();
    saveLocal();
    saveToDisk();
    renderMessages();
    updateCtxInfo();
}

// ★ 修复（新增）：streamUpdate 之前一直用 `s.messages[s.messages.length-1]` 取"当前消息"。
//   这在普通对话里是对的，但只要开了工具调用就错了 —— 工具结果消息（role:"tool"，
//   hidden:true）会被 push 到数组末尾，而它在 renderMessages 里是【不渲染】的。
//   结果：
//     · data-last="1" 落在 aiMsg 的 wrap 上（这是对的），
//     · 但 streamUpdate 拿 s.messages[length-1] 却拿到那条 tool 消息，
//     · 于是把工具结果 JSON 直接渲染进了 AI 回答的气泡里 ——
//       表现为多轮工具调用时，AI 回答的位置会短暂闪一下工具返回值。
//   修法：从 wrap.dataset.idx 反查真正的消息下标，与 renderMessages 的判定一致。
function streamUpdate(){
  const wrap=document.querySelector('.msg-wrap[data-last="1"]');
  if(!wrap){renderMessages();return}
  const s=getCurrentSession();
  const idx=parseInt(wrap.dataset.idx,10);
  const m=(Number.isInteger(idx)&&idx>=0&&s.messages[idx])?s.messages[idx]:s.messages[s.messages.length-1];
  if(!m){renderMessages();return}
  const now=Date.now();
  if(now-lastStreamSaveTs>1500){lastStreamSaveTs=now;try{saveLocal()}catch(e){}}
  if(m.groupId){renderMessages();return}
  const {thinking,content}=getThinkAndContent(m);
  const oldBox=wrap.querySelector(".think-box");
  const userToggled=oldBox&&oldBox.dataset.userToggled==="1";
  const wasOpen=oldBox&&oldBox.classList.contains("open");
  wrap.innerHTML=buildMessageInner(m,true,idx);
  postRender(wrap);updateCtxInfo();
  const newBox=wrap.querySelector(".think-box");
  if(newBox){
    if(userToggled){newBox.dataset.userToggled="1";if(wasOpen)newBox.classList.add("open")}
    else{if(generating&&thinking&&!content)newBox.classList.add("open");else newBox.classList.remove("open")}
    const metaEl=newBox.querySelector(".think-meta");
    if(metaEl)metaEl.textContent=(generating&&thinking&&!content)?"思考中…":(thinking.length+" 字");
    newBox.querySelector(".think-head").onclick=()=>{newBox.classList.toggle("open");newBox.dataset.userToggled="1"};
  }
  bindMsgActions(wrap,m,idx);
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
  // ★ 1.23：工具调用卡片折叠（与 RAG 卡片同一套交互）
  wrap.querySelectorAll(".tool-call-head").forEach(head=>{if(head&&!head.onclick)head.onclick=()=>head.parentElement.classList.toggle("open");});
  // ★ 1.23：点击图片放大预览
  wrap.querySelectorAll(".msg-image").forEach(img=>{
    img.onclick=()=>openImageViewer(img.dataset.imgSrc||img.src);
  });

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

// ============ ★ 1.23：用户消息里的图片 ============
function buildUserImagesHtml(m){
  const imgs = m && m.images;
  if(!Array.isArray(imgs) || !imgs.length) return "";
  const items = imgs.map((im,i)=>{
    const src = im.dataUrl || "";
    if(!src) return "";
    return `<img class="msg-image" src="${src}" alt="${escapeHtml(im.name||"图片")}" data-img-src="${src}" title="${escapeHtml(im.name||"")}（点击放大）">`;
  }).filter(Boolean).join("");
  if(!items) return "";
  return `<div class="msg-images">${items}</div>`;
}

// 点击图片放大预览
// ★ 修复：预览层原来会显示不全。
//   .modal-mask 提供 position:fixed 铺满屏幕，但尺寸约束写在 `.modal-mask .modal` 上
//   （max-width:92vw / max-height:86vh / overflow:auto）。原来的 <img> 只带
//   .img-viewer-img，匹配不到 .modal，于是大图会按原始像素渲染、超出部分被裁掉。
//   这里给 <img> 加上 modal 类复用尺寸约束，并在 tools.css 里清掉卡片样式。
function openImageViewer(src){
  if(!src) return;
  let mask = document.getElementById("imgViewerMask");
  if(!mask){
    mask = document.createElement("div");
    mask.id = "imgViewerMask";
    mask.className = "modal-mask img-viewer-mask";
    mask.innerHTML = `<img class="modal img-viewer-img" alt="预览">`;
    mask.onclick = () => mask.classList.remove("show");
    document.body.appendChild(mask);
  }
  const img = mask.querySelector(".img-viewer-img");
  if(img) img.src = src;
  mask.classList.add("show");
}

// ============ ★ 1.23：工具调用过程卡片 ============
function buildToolCallsHtml(m){
  const calls = m && m.toolCalls;
  const results = (m && m.toolResults) || [];
  if((!Array.isArray(calls) || !calls.length) && !results.length) return "";
  const n = Math.max(calls ? calls.length : 0, results.length);
  if(!n) return "";

  const items = [];
  for(let i=0;i<n;i++){
    const call = (calls && calls[i]) || {};
    const res = results[i] || null;
    const name = (call.function && call.function.name) || (res && res.name) || "未知工具";
    const label = (typeof getToolDisplayName === "function") ? getToolDisplayName(name) : name;
    const argsRaw = (call.function && call.function.arguments) || (res && res.args) || "";
    let argsPretty = argsRaw || "{}";
    try { const p = JSON.parse(argsRaw); argsPretty = JSON.stringify(p, null, 2); } catch(e){}
    const status = res ? (res.ok ? `<span class="tool-status tool-ok">成功</span>` : `<span class="tool-status tool-err">失败</span>`) : `<span class="tool-status tool-pending">执行中…</span>`;
    const ms = (res && res.ms) ? `<span class="tool-ms">${res.ms}ms</span>` : "";
    const resultHtml = res
      ? `<pre class="tool-result">${escapeHtml(res.text || "")}</pre>`
      : `<div class="tool-result pending">等待结果…</div>`;
    items.push(`<div class="tool-call-item">
      <div class="tool-call-head-row">
        <span class="tool-call-name" title="${escapeHtml(name)}">🔧 ${escapeHtml(label)}</span>
        ${status}${ms}
      </div>
      <div class="tool-call-block"><div class="tool-call-label">参数</div><pre class="tool-args">${escapeHtml(argsPretty)}</pre></div>
      <div class="tool-call-block"><div class="tool-call-label">结果</div>${resultHtml}</div>
    </div>`);
  }

  return `<div class="tool-call-box"><div class="tool-call-head"><span class="tool-arrow"></span><span>🔧 工具调用 ${n} 次</span></div><div class="tool-call-list">${items.join("")}</div></div>`;
}

// ============ ★ 1.23：费用徽章 ============
// 只对服务端返回了真实 token 用量的消息显示，展示"这一次花了多少钱"。
// estimateCost / isLocalModel 来自 stats.js；未加载时静默不显示。
function buildCostBadgeHtml(m, realP, realC, hasReal){
  if(typeof estimateCost !== "function") return "";
  if(!hasReal) return "";
  const model = m.model || (m.compare && m.compare[0] && m.compare[0].model) || cfg.model || "";
  if(!model) return "";
  let cost = 0, isLocal = false;
  try {
    const provider = (cfg.providers || []).find(p => p.id === m.providerId) || null;
    const total = realP + realC;
    cost = estimateCost(model, realP, realC) || 0;
    if(typeof isLocalModel === "function") isLocal = !!isLocalModel(model, provider);
    // 价格表未覆盖且不是本地模型时，不显示费用（避免误导成"免费"）
    if(!isLocal && cost <= 0 && typeof isLocalModel === "function") {
      const covered = (typeof USAGE_PRICE_TABLE !== "undefined") && Object.keys(USAGE_PRICE_TABLE).some(k => model.toLowerCase().includes(k));
      if(!covered) return "";
    }
    if(total <= 0) return "";
  } catch(e){ return ""; }
  const text = (cost <= 0)
    ? (isLocal ? "💰 本地免费" : "💰 免费")
    : ("💰 $" + (cost < 0.0001 ? cost.toExponential(2) : cost.toFixed(4)));
  const title = isLocal ? "本地模型，无 API 费用" : `按参考价估算：prompt ${realP} + completion ${realC} token`;
  return `<span class="msg-cost${isLocal ? " local" : ""}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
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
    // ★ 1.23：把用户消息里附带的图片渲染出来（点击可放大）
    const imgHtml = buildUserImagesHtml(m);
    return `${floatBtns}<div class="msg"><div class="avatar user">你</div><div class="msg-body"><div class="msg-role">你 ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div>${imgHtml}<div class="msg-content">${renderMarkdown(m.content)}</div></div></div>`;
  }
  if(m.compare){
    // ★ 修复（5）：compare 数组长度未校验。
    //   原来直接取 m.compare[0] / m.compare[1] 再无保护地读 .content，
    //   一旦数组只有 1 项（对比生成中途失败、被中断、或历史数据损坏），
    //   就会抛 TypeError 并让整个 renderMessages 挂掉——表现为整页消息白屏。
    //   这里做三重保护：缺位补齐成占位对象、非数组直接降级成普通消息、字段访问全部兜底。
    if(!Array.isArray(m.compare) || !m.compare.length){
      // 完全没有对比数据，按普通 assistant 消息渲染，而不是报错
      const fallback={...m};delete fallback.compare;
      return buildMessageInner(fallback,isStreamingLast,idx);
    }
    const mkCol=(c,i)=>{
      const o=(c&&typeof c==="object")?c:{};
      return { model:o.model||("模型 "+(i===0?"A":"B")), content:o.content||"", thinking:o.thinking||"" };
    };
    const c0=mkCol(m.compare[0],0),c1=mkCol(m.compare[1],1);
    const t0=estimateTokens(c0.content+c0.thinking),t1=estimateTokens(c1.content+c1.thinking);
    const tokensHtml=`<span class="msg-tokens">≈ ${t0} / ${t1} token</span>`;
    const colHtml=(c)=>{const {thinking,content}=getThinkAndContent(c);const thinkHtml=thinking?`<div class="think-box"><div class="think-head"><span class="think-arrow"></span><span class="think-label">深度思考</span><span class="think-meta">${thinking.length} 字</span></div><div class="think-content">${escapeHtml(thinking)}</div></div>`:"";return `<div class="compare-col"><div class="compare-head"><span class="dot"></span>${escapeHtml(c.model)}<span style="margin-left:auto;display:flex;gap:4px"><button class="msg-fbtn cmp-copy" style="width:24px;height:24px;font-size:11px" title="复制这条回答">📋</button><button class="msg-fbtn cmp-export" style="width:24px;height:24px;font-size:11px" title="导出这条回答 (.md)">↧</button></span></div>${thinkHtml}<div class="msg-content">${renderMarkdown(content)}</div></div>`;};
    const floatBtns=`<div class="msg-float">${quoteBtn}${starBtn}${delBtn}</div>`;
    const skillBadge = m.skillName ? `<span class="msg-skill" title="本次回答使用的 Skill">🧩 ${escapeHtml(m.skillName)}</span>` : "";
    return `${floatBtns}<div class="msg"><div class="avatar ai">⚖️</div><div class="msg-body"><div class="msg-role">模型对比 ${tokensHtml} ${skillBadge} ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div><div class="msg-compare">${colHtml(c0)}${colHtml(c1)}</div></div></div>`;
  }
  // ★ 1.23：优先显示服务端返回的真实 token 用量，历史消息没有真实值时才回退到估算
  const realP = toTokenNum(m.promptTokens), realC = toTokenNum(m.completionTokens);
  const hasReal = (realP > 0 || realC > 0);
  const tokens = hasReal ? (realP + realC) : estimateTokens(m.content+(m.thinking||""));
  let tokenInfo = "";
  if(hasReal){
    tokenInfo = `↑${realP} ↓${realC}`;
  } else if(tokens){
    tokenInfo = `≈ ${tokens} token`;
  }
  if(m.speed&&m.speed>0)tokenInfo+=` · ${m.speed.toFixed(1)} tok/s`;
  // ★ 1.23：费用徽章
  const costHtml = buildCostBadgeHtml(m, realP, realC, hasReal);
  const msgTokens=(tokenInfo||costHtml)?`<span class="msg-tokens"${hasReal?' title="服务端返回的真实 token 用量（prompt / completion）"':''}>${tokenInfo}</span>${costHtml}`:"";
  let versionNav="";
  if(m.versions&&m.versions.length>1){
    const cur=(m.currentVersion||0)+1;const total=m.versions.length;
    versionNav=`<span class="version-nav"><button class="ver-prev" title="上一个版本" ${m.currentVersion<=0?"disabled":""}>◀</button><span>${cur} / ${total}</span><button class="ver-next" title="下一个版本" ${m.currentVersion>=total-1?"disabled":""}>▶</button></span>`;
  }

  const ragHtml = buildRagSourcesHtml(m.ragSources);
  // ★ 1.23：工具调用过程卡片（展示在正文之前，因为调用发生在最终回答之前）
  const toolHtml = (typeof buildToolCallsHtml === "function") ? buildToolCallsHtml(m) : "";

  const body=renderAiBody(m,isStreamingLast);
  let actions="";
  if(isStreamingLast&&!generating&&(m.content||m.thinking)){
    actions=`<div class="msg-actions"><button class="msg-action continue-btn" title="继续写">▶ 继续生成</button><button class="msg-action regen-btn" title="重新生成">🔄 重新生成</button><button class="msg-action branch-btn" title="从这一刻创建分支">🌿 分叉</button></div>`;
  }
  const floatBtns=`<div class="msg-float"><button class="msg-fbtn copy-btn" title="复制">📋</button><button class="msg-fbtn speak-btn" title="朗读这条回答">🔊</button>${quoteBtn}${starBtn}${delBtn}<button class="msg-fbtn export-one-btn" title="导出这条回答 (.md)">↧</button></div>`;
  const skillBadge = m.skillName ? `<span class="msg-skill" title="本次回答使用的 Skill">🧩 ${escapeHtml(m.skillName)}</span>` : "";
  return `${floatBtns}<div class="msg"><div class="avatar ai">AI</div><div class="msg-body"><div class="msg-role">${escapeHtml(m.model||cfg.model||"AI")} ${skillBadge} ${msgTokens} ${versionNav} ${m.starred?'<span style="color:#f5b301">★</span>':''} ${timeHtml}</div>${toolHtml}${body}${ragHtml}${actions}</div></div>`;
}

function getMsgPreview(m){if(!m)return"";if(m.isSummary)return"【摘要】"+(m.content||"").slice(0,60);if(m.compare){const t=(m.compare[0]&&m.compare[0].content)||"";return"【对比】"+replaceEmo(t).slice(0,60);}if(m.role==="user")return"你："+replaceEmo(m.content||"").slice(0,60);return"AI："+replaceEmo(m.content||"").slice(0,60);}
function renderMsgNav(){
  const nav=document.getElementById("msgNav");const s=getCurrentSession();nav.innerHTML="";navTicks=[];
  navTicksByMsgIdx={};
  if(navObserver){navObserver.disconnect();navObserver=null}
  if(!s||!s.messages.length){nav.classList.remove("show");return}
  if(s.messages.length<3){nav.classList.remove("show");return}
  nav.classList.add("show");
  s.messages.forEach((m,i)=>{
    // ★ 1.23：工具结果消息不占导航刻度
    if(m.hidden||m.role==="tool")return;
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
    // ★ 修复（7）：navTicks 索引错位。
    //   navTicks 是"密集数组"（只 push 可见消息的刻度），但 setupNavObserver 与
    //   updateNavActiveOnScroll 都用【消息下标】去索引它：
    //       navTicks[parseInt(en.target.dataset.idx)]
    //   只要存在被跳过的消息（隐藏/工具结果），两者就会错位，
    //   表现为：高亮高亮错的那一条、或大量刻度永远不亮。
    //   这里额外维护一张"消息下标 → 刻度元素"的映射，供上面两处使用。
    navTicksByMsgIdx[i]=tick;
    nav.appendChild(tick);navTicks.push(tick);
  });
  setupNavObserver();
}
function setupNavObserver(){
  if(navObserver){navObserver.disconnect()}if(!navTicks.length)return;
  const root=document.getElementById("messages");
  navObserver=new IntersectionObserver((entries)=>{entries.forEach(en=>{
    const raw=en.target.dataset.idx;if(raw===undefined)return;
    // ★ 修复（7）：按消息下标查映射，而不是按密集数组下标
    const tick=navTicksByMsgIdx[parseInt(raw,10)];if(!tick)return;
    if(en.isIntersecting)tick.classList.add("active");else tick.classList.remove("active");
  });},{root:root,threshold:0.3});
  document.querySelectorAll("#messages .msg-wrap").forEach(w=>navObserver.observe(w));
}
function updateNavActiveOnScroll(){
  if(!navTicks.length)return;let anyActive=false;
  for(const t of navTicks){if(t.classList.contains("active")){anyActive=true;break}}
  if(anyActive)return;
  const box=document.getElementById("messages");const wraps=box.querySelectorAll(".msg-wrap");const top=box.getBoundingClientRect().top;let best=-1,bestDist=Infinity;
  wraps.forEach(w=>{const r=w.getBoundingClientRect();const d=Math.abs(r.top-top);if(d<bestDist){bestDist=d;best=parseInt(w.dataset.idx,10)}});
  navTicks.forEach(t=>t.classList.remove("active"));
  // ★ 修复（7）：同样按消息下标取刻度
  if(best>=0&&navTicksByMsgIdx[best])navTicksByMsgIdx[best].classList.add("active");
}

function renderMessages(){
  const box=document.getElementById("messages");const s=getCurrentSession();
  if(!s||!s.messages.length){box.innerHTML=`<div style="text-align:center;color:var(--text-dim);margin-top:80px;font-size:15px;"><div style="font-size:40px;margin-bottom:10px">💬</div>开始一个新的对话吧</div>`;renderMsgNav();updateCtxInfo();return;}
  // ★ 修复（6）：data-last="1" 在工具调用后丢失。
  //   原来是 `const isLast = i === s.messages.length-1`，但工具调用会把 role:"tool"
  //   的结果消息推到数组末尾，而它在第 447 行被跳过不渲染。
  //   于是"最后一条可见消息"永远拿不到 data-last="1"，导致：
  //     · streamUpdate() 找不到 .msg-wrap[data-last="1"]，退化成每帧全量重绘
  //     · "继续生成 / 重新生成 / 分叉"三个按钮（依赖 isStreamingLast）不再出现
  //   这里改为：先找出最后一条"可见"消息的下标，用它判断 isLast。
  const isVisible = (m) => !(m.hidden || m.role === "tool");
  let lastVisibleIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (isVisible(s.messages[i])) { lastVisibleIdx = i; break; }
  }
  box.innerHTML="";const rendered=new Set();
  s.messages.forEach((m,i)=>{
    if(rendered.has(i))return;
    // ★ 1.23：工具结果消息不单独渲染，它的内容已经展示在对应 AI 回答的工具卡片里
    if(!isVisible(m))return;
    const wrap=document.createElement("div");wrap.className="msg-wrap";wrap.dataset.idx=i;
    const isLast=(i===lastVisibleIdx);if(isLast)wrap.dataset.last="1";
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