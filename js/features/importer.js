// ============ 导入外部对话（ChatGPT / Claude） ============
// 本文件为独立模块，靠全局作用域与其他文件互相可见，不使用 import / export / IIFE。

// ★ 导入流程的临时状态（预览弹窗打开期间有效）
let impState = null;
// ★ 导入进度节流时间戳
let impLastTick = 0;
// ★ 会话 → 原始导出时间的缓存（不污染 session 对象）
const IMP_TIME = new WeakMap();

// ★ 生成一个不会与现有会话冲突的 id
function newImportSessionId(){
  return "s" + Date.now() + Math.random().toString(36).slice(2,7);
}

// ★ 把任意时间值归一化成毫秒时间戳
//   ChatGPT：Unix 秒（浮点）；Claude：ISO 字符串 / 秒 / 毫秒
function normImportTime(v){
  try{
    if(v === null || v === undefined || v === "") return null;
    if(typeof v === "string"){
      const ms = Date.parse(v);
      return isNaN(ms) ? null : ms;
    }
    if(typeof v === "number" && isFinite(v) && v > 0){
      if(v < 1e12) return Math.round(v * 1000);   // 秒
      return Math.round(v);                        // 毫秒
    }
  }catch(e){ console.warn("⚠️ 导入时间解析失败", e) }
  return null;
}

// ★ 格式化一段用于展示的时间
function fmtImportDate(ms){
  try{
    if(!ms) return "未知时间";
    const d = new Date(ms);
    const p = n => String(n).padStart(2,"0");
    return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }catch(e){ return "未知时间" }
}

// ★ 人类可读的文件体积
function fmtImportSize(n){
  const v = Number(n) || 0;
  if(v < 1024) return v + " B";
  if(v < 1024*1024) return (v/1024).toFixed(1) + " KB";
  if(v < 1024*1024*1024) return (v/1024/1024).toFixed(2) + " MB";
  return (v/1024/1024/1024).toFixed(2) + " GB";
}

// ★ 判断一个异常是不是 localStorage 配额爆了
function isImportQuotaError(e){
  try{
    if(!e) return false;
    if(e.name === "QuotaExceededError") return true;
    if(e.name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
    if(e.code === 22) return true;
    if(e.code === 1014) return true;
    const msg = String(e.message || e.name || "").toLowerCase();
    return msg.indexOf("quota") >= 0;
  }catch(err){ return false }
}

// ★ 从会话里取第一条用户消息
function firstImportUserMsg(s){
  const list = (s && s.messages) || [];
  for(const m of list){ if(m && m.role === "user" && m.content) return m }
  return null;
}

// ★ 从会话里取原始导出时间（优先 ChatGPT/Claude 的时间，其次内部时间）
function importSessionDate(s){
  if(!s) return 0;
  const cached = IMP_TIME.get(s);
  if(cached) return cached;
  const first = (s.messages && s.messages[0]) || null;
  return (first && first.time) || s.createdAt || s.updatedAt || 0;
}

// ============ A. 格式自动识别 ============

// ★ 识别 JSON 属于哪种导出格式
function detectImportFormat(json){
  try{
    if(!json) return "unknown";
    if(Array.isArray(json) && json[0] && json[0].mapping) return "chatgpt";
    if(Array.isArray(json) && json[0] && json[0].chat_messages) return "claude";
    if(json && Array.isArray(json.sessions)) return "limao";
  }catch(e){ console.warn("⚠️ 识别导入格式失败", e) }
  return "unknown";
}

// ============ B. ChatGPT 解析 ============

// ★ 把 ChatGPT 的 content.parts 拍平成纯文本
//   字符串直接取；多模态资源（图片/音频/附件）替换成占位符，其余结构跳过。
function extractImportPartsText(content){
  if(!content) return "";
  const parts = content.parts;
  if(!Array.isArray(parts) || !parts.length) return "";
  const out = [];
  for(const p of parts){
    if(p === null || p === undefined) continue;
    if(typeof p === "string"){ out.push(p); continue }
    if(typeof p === "object"){
      const ct = p.content_type || p.type || "";
      if(ct === "image_asset_pointer") out.push("[图片]");
      else if(ct === "audio_asset_pointer") out.push("[语音]");
      else if(ct === "video_asset_pointer" || ct === "video_container") out.push("[视频]");
      else if(ct === "file" || ct === "attachment" || ct === "file_asset_pointer") out.push("[附件]");
      // 其余（如 user_editable_context / model_editable_context 等）直接跳过
    }
  }
  return out.join("\n").trim();
}

// ★ 取 ChatGPT 节点的文本（parts 优先，content.text 兜底）
function importChatGptText(message){
  if(!message) return "";
  const c = message.content;
  if(!c) return "";
  let txt = extractImportPartsText(c);
  if(!txt && typeof c.text === "string") txt = c.text;
  return (txt || "").trim();
}

// ★ 沿 parent 向上回溯出一条线性路径，返回节点数组（时间正序）
//   用 Set 防止 mapping 成环导致死循环。
function backtraceImportChain(mapping, startId){
  const chain = [];
  const seen = new Set();
  let cur = startId;
  while(cur && mapping[cur] && !seen.has(cur)){
    seen.add(cur);
    chain.push(mapping[cur]);
    cur = mapping[cur].parent;
  }
  return chain.reverse();
}

// ★ 从 mapping 找一条最长的对话路径（current_node 缺失时的兜底）
//   ★ 真正修对了：原来 hasChild 装的是"被别人当作子节点的节点"（非根），
//   配合 `if(hasChild.has(id)) continue` 语义就变成了"跳过所有非根节点"，
//   再叠加"跳过所有还有子节点的节点"，最终 leaves 恒为空 ——
//   函数会静默退化到 create_time 排序，把分叉对话串成乱的。
//   正确做法：hasChild 表示"这个节点自己有子节点"（即"这个节点是父节点"），
//   叶子 = 有 message 且【没有】子节点的节点。
function findImportLongestChain(mapping){
  // 1) 收集"有子节点"的节点集合
  const hasChild = new Set();
  for(const id in mapping){
    const node = mapping[id];
    const kids = node && node.children;
    if(Array.isArray(kids) && kids.some(k => k && mapping[k])){
      hasChild.add(id);   // ★ 加的是"自己"，语义："我有子节点"
    }
  }
  // 2) 叶子 = 有 message 且没有任何有效子节点
  const leaves = [];
  for(const id in mapping){
    const node = mapping[id];
    if(!node || !node.message) continue;
    if(hasChild.has(id)) continue;   // ★ 现在语义正确：有子节点 → 不是叶子
    leaves.push(id);
  }
  // 3) 从每个叶子回溯，取最长的一条
  let best = [];
  for(const leaf of leaves){
    const chain = backtraceImportChain(mapping, leaf);
    if(chain.length > best.length) best = chain;
  }
  // 4) 兜底：children 字段整体缺失/错乱导致一个叶子都没找到时，
  //    退化成"所有带 message 的节点按 create_time 排序"，至少不丢对话。
  if(!best.length){
    const all = [];
    for(const id in mapping){
      const n = mapping[id];
      if(n && n.message) all.push(n);
    }
    all.sort((a,b)=>{
      const ta = (a.message && a.message.create_time) || 0;
      const tb = (b.message && b.message.create_time) || 0;
      return ta - tb;
    });
    best = all;
  }
  return best;
}

// ★ 解析单个 ChatGPT 会话对象
function parseImportChatGptConversation(conv){
  const skip = [];
  const empty = (reason) => ({ ok:false, reason:reason || "没有任何可用消息" });
  if(!conv || typeof conv !== "object") return empty("会话对象无效");
  const mapping = conv.mapping;
  if(!mapping || typeof mapping !== "object") return empty("缺少 mapping 字段");

  // 路径：current_node 回溯 → 最长叶子路径 → create_time 排序全量
  let chain = [];
  if(conv.current_node && mapping[conv.current_node]) chain = backtraceImportChain(mapping, conv.current_node);
  if(!chain.length) chain = findImportLongestChain(mapping);
  if(!chain.length){
    const all = [];
    for(const id in mapping){
      const n = mapping[id];
      if(n && n.message) all.push(n);
    }
    all.sort((a,b)=>{
      const ta = (a.message && a.message.create_time) || 0;
      const tb = (b.message && b.message.create_time) || 0;
      return ta - tb;
    });
    chain = all;
  }

  // 逐节点转消息
  const messages = [];
  for(const node of chain){
    if(!node || !node.message) continue;
    const m = node.message;
    // ★ 修复：跳过 ChatGPT 标记为"不显示在对话里"的消息（隐藏气泡），
    //   否则会导入一批用户从未见过的内容，把对话顺序搅乱。
    if(m.metadata && (m.metadata.is_visually_hidden_from_conversation === true ||
                      m.metadata.is_visually_hidden_from_conversation === "true")){
      skip.push("跳过隐藏消息");
      continue;
    }
    const roleRaw = (m.author && m.author.role) || "";
    if(roleRaw !== "user" && roleRaw !== "assistant"){
      // system / tool / 其它角色：本项目 buildMessages 只认 user/assistant，跳过
      if(roleRaw) skip.push("跳过 " + roleRaw + " 角色消息");
      continue;
    }
    const text = importChatGptText(m);
    if(!text) continue;   // ★ 内容为空白的消息跳过（图片/附件占位符本身也算有内容）
    const ms = normImportTime(m.create_time) || normImportTime(conv.update_time) || Date.now();
    if(roleRaw === "user"){
      messages.push({ role:"user", content:text, time:ms });
    }else{
      messages.push({ role:"assistant", content:text, thinking:"", model:"导入", time:ms });
    }
  }

  if(!messages.some(m => m.role === "user" || m.role === "assistant")) return empty("没有任何 user / assistant 消息");

  // 标题
  let title = (typeof conv.title === "string" ? conv.title.trim() : "");
  if(!title){
    const fu = firstImportUserMsg({ messages:messages });
    if(fu) title = (fu.content || "").trim().slice(0,20);
  }
  if(!title) title = "ChatGPT 导入";

  const firstTime = messages[0].time;
  const lastTime = messages[messages.length-1].time;
  const srcTime = normImportTime(conv.create_time) || normImportTime(conv.update_time) || firstTime;
  return { ok:true, messages:messages, title:title, srcTime:srcTime, span:{ first:firstTime, last:lastTime }, skip:skip };
}

// ★ 解析 ChatGPT 导出（顶层数组）
function parseImportChatGpt(json){
  const out = [];
  const list = Array.isArray(json) ? json : [];
  if(!list.length) return out;
  list.forEach((conv, i)=>{
    try{
      const r = parseImportChatGptConversation(conv);
      if(r.ok){
        const one = {
          id: newImportSessionId(),
          title: r.title,
          messages: r.messages,
          createdAt: r.srcTime || r.span.first,
          updatedAt: r.span.last || r.srcTime,
          pinned: false
        };
        IMP_TIME.set(one, r.span.first || r.srcTime);
        out.push(one);
        if(r.skip && r.skip.length) console.warn("⚠️ ChatGPT 会话「" + r.title + "」部分内容已跳过：" + r.skip.join("；"));
      }else{
        out.push({ __skipped:true, idx:i, title:(conv && typeof conv.title === "string" && conv.title) || ("第 " + (i+1) + " 个会话"), reason:r.reason });
      }
    }catch(e){
      console.warn("⚠️ 解析 ChatGPT 会话失败，已跳过", e);
      out.push({ __skipped:true, idx:i, title:(conv && conv.title) || ("第 " + (i+1) + " 个会话"), reason:"解析异常" });
    }
  });
  return out;
}

// ============ C. Claude 解析 ============

// ★ 解析单条 Claude 消息
function parseImportClaudeMessage(m){
  if(!m || typeof m !== "object") return null;
  const sender = m.sender || "";
  let role = "";
  if(sender === "human") role = "user";
  else if(sender === "assistant") role = "assistant";
  else return null;   // 其它 sender 不导入

  const texts = [];
  let thinking = "";
  if(Array.isArray(m.content)){
    for(const c of m.content){
      if(!c || typeof c !== "object") continue;
      if(c.type === "text" && typeof c.text === "string") texts.push(c.text);
      else if(c.type === "thinking"){
        const tk = (typeof c.thinking === "string" && c.thinking) || (typeof c.text === "string" && c.text) || "";
        if(tk) thinking += (thinking ? "\n\n" : "") + tk;
      }
      // tool_use / tool_result 等结构化内容忽略，不导入
    }
  }
  let content = (typeof m.text === "string" ? m.text : "").trim();
  if(!content) content = texts.join("\n").trim();
  // ★ 只有正文和思考都为空时才丢弃；否则「正文空 + 有思考」的消息会白白丢掉思考
  if(!content && !thinking) return null;

  const time = normImportTime(m.created_at) || normImportTime(m.updated_at) || Date.now();
  if(role === "user") return { role:"user", content:content, time:time };
  return { role:"assistant", content:content, thinking:thinking, model:"导入", time:time };
}

// ★ 解析单个 Claude 会话对象
function parseImportClaudeConversation(conv){
  if(!conv || typeof conv !== "object") return { ok:false, reason:"会话对象无效" };
  const raw = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  const messages = [];
  let emptyCount = 0;
  for(const m of raw){
    try{
      const one = parseImportClaudeMessage(m);
      if(one) messages.push(one);
      else emptyCount++;
    }catch(e){ console.warn("⚠️ 解析 Claude 单条消息失败，已跳过", e); emptyCount++ }
  }
  if(!messages.length) return { ok:false, reason:"没有任何 human / assistant 消息" };

  let title = (typeof conv.name === "string" ? conv.name.trim() : "");
  if(!title) title = "Claude 导入";

  const srcTime = normImportTime(conv.created_at) || normImportTime(conv.updated_at) || messages[0].time;
  const updTime = normImportTime(conv.updated_at);
  const lastTime = messages[messages.length-1].time;
  const skip = [];
  if(emptyCount) skip.push("跳过 " + emptyCount + " 条空消息或非 human/assistant 消息");
  return { ok:true, messages:messages, title:title, srcTime:srcTime, span:{ first:srcTime, last:(updTime || lastTime) }, skip:skip };
}

// ★ 解析 Claude 导出（顶层数组）
function parseImportClaude(json){
  const out = [];
  const list = Array.isArray(json) ? json : [];
  if(!list.length) return out;
  list.forEach((conv, i)=>{
    try{
      const r = parseImportClaudeConversation(conv);
      if(r.ok){
        const one = {
          id: newImportSessionId(),
          title: r.title,
          messages: r.messages,
          createdAt: r.srcTime,
          updatedAt: r.span.last || r.srcTime,
          pinned: false
        };
        IMP_TIME.set(one, r.span.first || r.srcTime);
        out.push(one);
        if(r.skip && r.skip.length) console.warn("⚠️ Claude 会话「" + r.title + "」部分内容已跳过：" + r.skip.join("；"));
      }else{
        out.push({ __skipped:true, idx:i, title:(conv && conv.name) || ("第 " + (i+1) + " 个会话"), reason:r.reason });
      }
    }catch(e){
      console.warn("⚠️ 解析 Claude 会话失败，已跳过", e);
      out.push({ __skipped:true, idx:i, title:(conv && conv.name) || ("第 " + (i+1) + " 个会话"), reason:"解析异常" });
    }
  });
  return out;
}

// ============ D. 去重辅助 ============

// ★ 生成 32 位小整数 hash
function importHash32(str){
  const s = String(str || "");
  let h = 5381;
  for(let i = 0; i < s.length; i++){
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;   // h * 33 + c
  }
  return (h >>> 0).toString(36);
}

// ★ 去重键：标题 + 首条 user 消息前 40 字，转小写后取 hash
function buildImportDedupeKey(s){
  try{
    if(!s) return importHash32("");
    const title = String(s.title || "").trim().toLowerCase();
    const fu = firstImportUserMsg(s);
    const head = fu ? String(fu.content || "").trim().replace(/\s+/g," ").slice(0,40).toLowerCase() : "";
    return importHash32(title + "\u0001" + head);
  }catch(e){ console.warn("⚠️ 生成去重键失败", e); return importHash32("") }
}

// ★ 找出与现有全局 sessions 重复的索引集合（只提示，绝不自动删除）
function findDuplicateSessions(newSessions){
  const dup = new Set();
  try{
    const list = Array.isArray(newSessions) ? newSessions : [];
    if(!list.length) return dup;
    const exist = new Set();
    for(const s of (Array.isArray(sessions) ? sessions : [])){
      if(s) exist.add(buildImportDedupeKey(s));
    }
    if(!exist.size) return dup;
    const selfSeen = new Set();
    list.forEach((s, i)=>{
      if(!s || s.__skipped) return;
      const k = buildImportDedupeKey(s);
      if(exist.has(k) || selfSeen.has(k)) dup.add(i);
      selfSeen.add(k);
    });
  }catch(e){ console.warn("⚠️ 重复检测失败", e) }
  return dup;
}

// ============ D. 格式 → 内部会话结构 ============

// ★ 把外部 JSON 转成本项目的 session 数组
function convertImported(json, format){
  const fmt = format || detectImportFormat(json);
  const raw = [];
  const skipped = [];

  if(fmt === "chatgpt" || fmt === "claude"){
    const parsed = (fmt === "chatgpt") ? parseImportChatGpt(json) : parseImportClaude(json);
    for(const item of parsed){
      if(item && item.__skipped){
        skipped.push({ title:item.title, reason:item.reason || "空会话" });
      }else{
        raw.push(item);
      }
    }
  }else if(fmt === "limao"){
    skipped.push({ title:"（整个文件）", reason:"这是狸猫自己的备份格式，请使用侧栏的「恢复全部」功能" });
  }else{
    skipped.push({ title:"（整个文件）", reason:"无法识别的 JSON 结构" });
  }

  // 二次兜底：跳过没有任何 user/assistant 消息的会话，同时保证三种 Message 形状合法
  const sessionsOut = [];
  for(const s of raw){
    const msgs = [];
    for(const m of ((s && s.messages) || [])){
      // ★ 空气泡跳过；但「正文空 + 有思考」的 AI 消息要保留（只丢思考会很可惜）
      if(!m) continue;
      if(!m.content && !((m.role === "assistant") && m.thinking)) continue;
      if(m.role === "user") msgs.push({ role:"user", content:m.content, time:m.time || Date.now() });
      else if(m.role === "assistant"){
        if(m.isSummary) msgs.push({ role:"assistant", content:m.content, isSummary:true, time:m.time || Date.now() });
        else msgs.push({ role:"assistant", content:m.content || "", thinking:m.thinking || "", model:"导入", time:m.time || Date.now() });
      }
    }
    if(!msgs.length){ skipped.push({ title:(s && s.title) || "未命名", reason:"没有任何 user / assistant 消息" }); continue }
    const times = msgs.map(m => m.time).filter(t => t > 0);
    const created = (s && s.createdAt) || (times.length ? Math.min.apply(null, times) : Date.now());
    const updated = (s && s.updatedAt) || (times.length ? Math.max.apply(null, times) : created);
    const keep = {
      id: (s && s.id) || newImportSessionId(),
      title: (s && s.title) || "导入的对话",
      messages: msgs,
      createdAt: created,
      updatedAt: updated,
      pinned: false
    };
    const cached = s ? IMP_TIME.get(s) : 0;
    if(cached) IMP_TIME.set(keep, cached);
    sessionsOut.push(keep);
  }

  // 统计
  let totalMessages = 0;
  let earliest = 0, latest = 0;
  for(const s of sessionsOut){
    totalMessages += s.messages.length;
    const t = importSessionDate(s);
    if(t){ if(!earliest || t < earliest) earliest = t; if(!latest || t > latest) latest = t }
  }
  const statsAll = {
    format: fmt,
    totalSessions: (fmt === "chatgpt" || fmt === "claude") ? (Array.isArray(json) ? json.length : 0) : 0,
    importable: sessionsOut.length,
    skippedCount: skipped.length,
    skipped: skipped,
    totalMessages: totalMessages,
    earliest: earliest,
    latest: latest
  };
  return { sessions: sessionsOut, skipped: skipped, statsAll: statsAll };
}

// ============ E. 预览 + 勾选 UI ============

// ★ 触发隐藏的 file input（若已有待预览数据则直接重新打开弹窗）
function openImportExternal(){
  try{
    if(impState && impState.sessions){ renderImportPreview(); const m = document.getElementById("importExternalMask"); if(m) m.classList.add("show"); return }
    const inp = document.getElementById("importExternalFile");
    if(inp) inp.click();
    else alert("找不到文件选择框（#importExternalFile），请检查 index.html 集成。");
  }catch(e){ console.warn("⚠️ 打开导入面板失败", e) }
}

// ★ 隐藏预览弹窗，并清掉尚未确认的临时数据
function closeImportExternal(){
  try{
    const mask = document.getElementById("importExternalMask");
    if(mask) mask.classList.remove("show");
    impState = null;
  }catch(e){ console.warn("⚠️ 关闭导入面板失败", e) }
}

// ★ 估算浏览器本地存储余量（不支持 navigator.storage 时返回 null）
async function estimateImportStorage(){
  try{
    if(!navigator.storage || typeof navigator.storage.estimate !== "function") return null;
    const est = await navigator.storage.estimate();
    if(!est) return null;
    return { usage: est.usage || 0, quota: est.quota || 0, free: Math.max(0, (est.quota || 0) - (est.usage || 0)) };
  }catch(e){ console.warn("⚠️ 无法估算本地存储余量", e); return null }
}

// ★ 估算导入数据的 JSON 体积（字符串长度近似字节数）
function estimateImportPayloadSize(list){
  try{
    return JSON.stringify({ sessions: list || [] }).length;
  }catch(e){ console.warn("⚠️ 估算导入数据体积失败", e); return 0 }
}

// ★ 弹窗里的存储余量提示
function buildImportStorageHintHtml(){
  const st = impState && impState.storage;
  const sizeTxt = impState ? fmtImportSize(impState.payloadSize || 0) : "未知";
  if(!st){
    return '<div class="imp-warn">⚠️ 当前对话保存在浏览器 localStorage（约 5MB 上限）。本次勾选内容的 JSON 体积约 <b>' + escapeHtml(sizeTxt) + '</b>；浏览器不支持存储余量估算，超限时会自动回滚。</div>';
  }
  const free = st.free;
  const pressure = (impState.payloadSize || 0) > free;
  const cls = pressure ? "imp-warn danger" : "imp-warn";
  let html = '<div class="' + cls + '">';
  if(pressure){
    html += '⚠️ 本次勾选内容的 JSON 体积约 <b>' + escapeHtml(sizeTxt) + '</b>，已超过浏览器本地存储可用余量（约 <b>' + escapeHtml(fmtImportSize(free)) + '</b>）。<br>建议：只勾选一部分会话分次导入，或先在「设置 → 存储目录」绑定一个文件夹（数据会写入磁盘 conversations.json，没有 5MB 限制）。';
  }else{
    html += '💾 本次勾选内容的 JSON 体积约 <b>' + escapeHtml(sizeTxt) + '</b>，本地存储可用余量约 <b>' + escapeHtml(fmtImportSize(free)) + '</b>。';
  }
  const folderTxt = (typeof folderHandle !== "undefined" && folderHandle)
    ? '<br>✅ 已检测到已绑定的存储目录「' + escapeHtml(folderHandle.name || "") + '」，数据同时会写入磁盘，配额压力很小。'
    : '<br>ℹ️ 未绑定存储目录。若导入量很大，建议先在「设置 → 存储目录」绑定一个文件夹。';
  html += folderTxt + '</div>';
  return html;
}

// ★ 渲染预览弹窗内容
function renderImportPreview(){
  const body = document.getElementById("importExternalBody");
  if(!body) { console.warn("⚠️ 找不到 #importExternalBody，无法渲染导入预览"); return }
  const btn = document.getElementById("confirmImportExternalBtn");
  const setBtn = (disabled, text) => {
    if(!btn) return;
    btn.disabled = !!disabled;
    btn.textContent = text || "开始导入";
  };

  if(!impState){
    body.innerHTML = '<div class="imp-hint">还没有选择文件。请点击侧栏的「导入对话」按钮选择一个 JSON 文件。</div>';
    setBtn(true);
    return;
  }

  const fmt = impState.format;
  const st = impState.statsAll || {};
  const sessionsList = impState.sessions || [];

  // 摘要行
  const fmtName = fmt === "chatgpt" ? "ChatGPT" : (fmt === "claude" ? "Claude" : (fmt === "limao" ? "狸猫AI工具盒备份" : "未知"));
  const rangeTxt = (st.earliest && st.latest) ? (fmtImportDate(st.earliest) + " ~ " + fmtImportDate(st.latest)) : "未知";
  let html = '<div class="imp-summary">';
  html += '<div>识别格式：<b>' + escapeHtml(fmtName) + '</b>　文件：<b>' + escapeHtml(impState.fileName || "未命名") + '</b>（' + escapeHtml(fmtImportSize(impState.fileSize || 0)) + '）</div>';
  if(fmt === "chatgpt" || fmt === "claude"){
    html += '<div>共 <b>' + (st.totalSessions || 0) + '</b> 个会话　可导入 <b>' + (st.importable || 0) + '</b> 个　跳过 <b>' + (st.skippedCount || 0) + '</b> 个　总消息 <b>' + (st.totalMessages || 0) + '</b> 条</div>';
    html += '<div>时间范围：' + escapeHtml(rangeTxt) + '</div>';
  }
  html += '</div>';

  // 不支持 / 特殊格式：只提示，不给清单
  if(fmt === "limao"){
    html += '<div class="imp-warn danger">📦 这是狸猫自己的备份格式，请直接使用侧栏的 <b>「恢复全部」</b> 功能（备份文件里含设置、预设、草稿，本导入器不处理这些）。</div>';
    body.innerHTML = html;
    setBtn(true, "无法导入备份格式");
    return;
  }
  if(fmt === "unknown"){
    html += '<div class="imp-warn danger">❓ 无法识别这个 JSON 的结构。本导入器支持两种格式：<br>' +
            '① <b>ChatGPT</b> 导出包里的 <b>conversations.json</b>（顶层是数组，每项含 <code>mapping</code> 字段）；<br>' +
            '② <b>Claude</b> 导出的 <b>conversations.json</b>（顶层是数组，每项含 <code>chat_messages</code> 字段）。</div>';
    body.innerHTML = html;
    setBtn(true, "无法识别");
    return;
  }

  // 跳过原因摘要
  if(st.skipped && st.skipped.length){
    const preview = st.skipped.slice(0, 8).map(x => escapeHtml(x.title) + "（" + escapeHtml(x.reason) + "）").join("；");
    html += '<div class="imp-hint">跳过 ' + st.skippedCount + ' 个会话：' + preview + (st.skipped.length > 8 ? " …" : "") + '</div>';
  }

  // 存储余量提示
  html += buildImportStorageHintHtml();

  // 工具行
  html += '<div class="imp-tools">';
  html += '<button id="impSelectAll" type="button">全选</button>';
  html += '<button id="impSelectNone" type="button">全不选</button>';
  html += '<button id="impSelectUnique" type="button">只选非重复</button>';
  html += '<span class="imp-dup-tip">重复的会话默认不勾选；去重只是提示，不会自动删除。</span>';
  html += '</div>';

  // 会话清单
  if(!sessionsList.length){
    html += '<div class="imp-hint">没有可导入的会话。</div>';
  }else{
    html += '<div class="imp-list">';
    sessionsList.forEach((s, i)=>{
      const dup = impState.dupIdx.has(i);
      const when = importSessionDate(s);
      html += '<label class="imp-item">';
      html += '<input type="checkbox" class="imp-cb" data-idx="' + i + '"' + (dup ? "" : " checked") + '>';
      html += '<span class="imp-title">' + escapeHtml(s.title || "未命名") + '</span>';
      if(dup) html += '<span class="imp-dup">⚠️ 疑似重复</span>';
      html += '<span class="imp-meta">' + s.messages.length + ' 条 · ' + escapeHtml(fmtImportDate(when)) + '</span>';
      html += '</label>';
    });
    html += '</div>';
  }

  // 实时统计 + 导入方式说明 + 进度位
  html += '<div class="imp-stats" id="impSelectionStats"></div>';
  html += '<div class="imp-mode">导入方式：<b>追加</b>导入，不会覆盖或删除你现有的对话。</div>';
  html += '<div class="imp-progress" id="impProgress"></div>';

  body.innerHTML = html;
  setBtn(false, "开始导入");

  // 绑定（列表项不用事件委托）
  body.querySelectorAll(".imp-cb").forEach(el=>{
    el.onchange = () => updateImportSelectionStats();
  });
  const bindTool = (id, fn) => { const b = document.getElementById(id); if(b) b.onclick = fn };
  bindTool("impSelectAll", () => setImportSelection("all"));
  bindTool("impSelectNone", () => setImportSelection("none"));
  bindTool("impSelectUnique", () => setImportSelection("unique"));

  updateImportSelectionStats();
}

// ★ 按模式改变勾选状态
function setImportSelection(mode){
  try{
    const body = document.getElementById("importExternalBody");
    if(!body) return;
    body.querySelectorAll(".imp-cb").forEach(el=>{
      const idx = parseInt(el.dataset.idx, 10);
      if(mode === "all") el.checked = true;
      else if(mode === "none") el.checked = false;
      else el.checked = !(impState && impState.dupIdx && impState.dupIdx.has(idx));
    });
    updateImportSelectionStats();
  }catch(e){ console.warn("⚠️ 批量勾选失败", e) }
}

// ★ 读当前勾选，返回 { sessions, messages, count, payloadSize }
function readImportSelection(){
  const out = { sessions:[], messages:0, count:0, payloadSize:0 };
  try{
    const body = document.getElementById("importExternalBody");
    if(!body || !impState || !impState.sessions) return out;
    const picked = [];
    body.querySelectorAll(".imp-cb").forEach(el=>{
      if(!el.checked) return;
      const idx = parseInt(el.dataset.idx, 10);
      const s = impState.sessions[idx];
      if(s) picked.push(s);
    });
    out.sessions = picked;
    out.count = picked.length;
    out.messages = picked.reduce((n, s) => n + ((s.messages && s.messages.length) || 0), 0);
    out.payloadSize = estimateImportPayloadSize(picked);
  }catch(e){ console.warn("⚠️ 读取勾选状态失败", e) }
  return out;
}

// ★ 刷新实时统计行
function updateImportSelectionStats(){
  const el = document.getElementById("impSelectionStats");
  if(!el) return;
  const sel = readImportSelection();
  el.textContent = "已选 " + sel.count + " 个会话 / " + sel.messages + " 条消息";
  const btn = document.getElementById("confirmImportExternalBtn");
  if(btn && impState && !btn.disabled) btn.textContent = sel.count ? ("开始导入（" + sel.count + "）") : "开始导入";
}

// ============ F. 读文件 + 执行导入 ============

// ★ 读取用户选择的文件 → 识别 → 转换 → 打开预览
async function handleExternalImportFile(file){
  try{
    if(!file){ return }
    // ★ 超大文件保护
    if(file.size > 300 * 1024 * 1024){
      if(!confirm("这个文件有 " + fmtImportSize(file.size) + "，读取和解析可能让页面卡住好几十秒甚至崩溃。仍然继续吗？")) return;
    }
    const name = file.name || "未命名.json";
    if(!/\.json$/i.test(name)){
      if(!confirm("这个文件不是 .json 结尾，可能不是 ChatGPT / Claude 的导出文件。仍然尝试解析吗？")) return;
    }
    setStatus("正在读取 " + name + " …");
    const text = await file.text();
    let json = null;
    try{
      json = JSON.parse(text);
    }catch(e){
      console.warn("⚠️ JSON 解析失败", e);
      alert("JSON 解析失败，这个文件可能不是合法的导出文件。\n\n" + (e && e.message ? e.message : ""));
      setStatus("导入失败", true);
      return;
    }

    const fmt = detectImportFormat(json);
    const res = convertImported(json, fmt);
    const dupIdx = findDuplicateSessions(res.sessions);
    const payloadSize = estimateImportPayloadSize(res.sessions);
    const storage = await estimateImportStorage();

    impState = {
      format: fmt,
      fileName: name,
      fileSize: file.size || 0,
      sessions: res.sessions,
      skipped: res.skipped,
      statsAll: res.statsAll,
      dupIdx: dupIdx,
      payloadSize: payloadSize,
      storage: storage
    };

    renderImportPreview();

    const mask = document.getElementById("importExternalMask");
    if(mask) mask.classList.add("show");

    if(fmt === "chatgpt" || fmt === "claude"){
      setStatus("已解析 " + res.sessions.length + " 个会话，待确认导入");
    }else if(fmt === "limao"){
      setStatus("这是狸猫自己的备份格式", true);
    }else{
      setStatus("无法识别的文件格式", true);
    }
  }catch(e){
    console.warn("⚠️ 读取导入文件失败", e);
    alert("读取失败：" + (e && e.message ? e.message : String(e)));
    setStatus("导入失败", true);
  }
}

// ★ 弹窗里的「确定」按钮入口：执行导入
async function confirmImportExternal(){
  try{
    if(!impState) return;
    if(impState.format !== "chatgpt" && impState.format !== "claude"){
      alert("这个文件无法导入。狸猫备份格式请用「恢复全部」；无法识别的文件请确认是 ChatGPT 的 conversations.json 或 Claude 的 conversations.json。");
      return;
    }
    const sel = readImportSelection();
    if(!sel.count){ alert("请至少勾选一个会话"); return }
    impState.payloadSize = sel.payloadSize;
    await doImportExternal(sel.sessions);
  }catch(e){ console.warn("⚠️ 确认导入失败", e) }
}

// ★ 真正落库：追加 + 分批 + 配额保护 + 回滚
async function doImportExternal(selectedSessions){
  const result = { imported:0, messages:0, failed:0 };
  const list = Array.isArray(selectedSessions) ? selectedSessions.filter(s => s && Array.isArray(s.messages)) : [];
  if(!list.length){ alert("没有可导入的会话"); return result }

  const prog = document.getElementById("impProgress");
  const btn = document.getElementById("confirmImportExternalBtn");
  const beforeLen = sessions.length;     // ★ 回滚锚点
  let added = 0;
  let addedMsgs = 0;

  // ★ 存储配额预检（仅提示，不阻断）
  try{
    const est = await estimateImportStorage();
    const size = estimateImportPayloadSize(list);
    const folderTxt = (typeof folderHandle !== "undefined" && folderHandle)
      ? "已绑定存储目录「" + (folderHandle.name || "") + "」，数据会写入磁盘，配额压力很小。"
      : "未绑定存储目录。若提示存储不足，可先在「设置 → 存储目录」绑定一个文件夹，数据会写到磁盘 conversations.json，没有 5MB 限制。";
    if(est && size > est.free){
      if(!confirm("待导入数据约 " + fmtImportSize(size) + "，超过浏览器本地存储可用余量（约 " + fmtImportSize(est.free) + "）。\n\n" +
                  "继续可能会在写到一半时配额爆掉并自动回滚。\n\n" + folderTxt + "\n\n仍然继续吗？")){
        return result;
      }
    }else if(est){
      console.warn("ℹ️ 导入预检：待导入约 " + fmtImportSize(size) + "，可用余量约 " + fmtImportSize(est.free) + "（导入前已有 " + beforeLen + " 个会话）");
    }
  }catch(e){ console.warn("⚠️ 导入前配额预检失败（已跳过）", e) }

  if(btn) btn.disabled = true;
  setStatus("正在导入 0/" + list.length + " …");

  // ★ 导入前先落一次盘，保证「回滚后」的 localStorage 是干净的原状态
  try{
    saveLocal();
  }catch(e){
    if(isImportQuotaError(e)){
      alert("导入前保存就失败了：浏览器本地存储已经满了。建议先删除一些对话，或先绑定「存储目录」把数据写到磁盘。");
      if(btn) btn.disabled = false;
      setStatus("导入失败", true);
      result.failed = list.length;
      return result;
    }
    console.warn("⚠️ 导入前保存失败", e);
  }

  try{
    for(let i = 0; i < list.length; i++){
      const s = list[i];
      try{
        // ★ 追加写：unshift 单个元素，绝不整体赋值覆盖 sessions
        sessions.unshift(s);
        added++;
        addedMsgs += (s.messages && s.messages.length) || 0;
        try{
          saveLocal();
        }catch(se){
          if(isImportQuotaError(se)){
            // ★ 配额爆掉：立即回滚
            try{ sessions.splice(0, added) }catch(re){ console.warn("⚠️ 回滚数组失败", re) }
            try{ saveLocal() }catch(re2){ console.warn("⚠️ 回滚后重新保存失败", re2) }
            console.warn("⚠️ 本地存储配额不足，已回滚 " + added + " 个会话", se);
            alert("浏览器本地存储（约 5MB）放不下这么多对话。已导入的 " + added + " 个已回滚，你的原有对话没有受影响。\n\n" +
                  "建议：\n① 只勾选部分会话再导入（可分几次）；\n" +
                  "② 先用「设置 → 存储目录」绑定一个文件夹，数据会写到磁盘 conversations.json，没有 5MB 限制。" +
                  ((typeof folderHandle !== "undefined" && folderHandle) ? "\n\n（检测到你已绑定存储目录，可用它来避免这个限制。）" : ""));
            setStatus("导入失败：本地存储已满，已回滚", true);
            result.imported = 0;
            result.messages = 0;
            result.failed = list.length - i;
            if(prog) prog.textContent = "❌ 存储空间不足，已回滚 " + added + " 个会话。";
            if(btn) btn.disabled = false;
            return result;
          }
          // ★ 非配额错误：只记日志，不中断
          console.warn("⚠️ 保存本次导入失败（非配额原因，继续）", se);
        }
      }catch(e){
        console.warn("⚠️ 导入第 " + (i+1) + " 个会话失败，已跳过", e);
        result.failed++;
      }

      // ★ 分批让出主线程 + 刷新进度
      if((i + 1) % 20 === 0){
        const now = Date.now();
        if(now - impLastTick > 120){
          impLastTick = now;
          setStatus("正在导入 " + (i+1) + "/" + list.length + " …");
          if(prog) prog.textContent = "⏳ 正在导入 " + (i+1) + "/" + list.length + " 个会话…";
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ★ 收尾
    result.imported = added;
    result.messages = addedMsgs;

    try{ saveLocal() }catch(e){ console.warn("⚠️ 导入收尾保存失败", e) }
    try{ saveToDisk() }catch(e){ console.warn("⚠️ 写入存储目录失败", e) }
    try{ renderSessions() }catch(e){ console.warn("⚠️ 刷新侧栏失败", e) }
    try{ renderMessages() }catch(e){ console.warn("⚠️ 刷新消息区失败", e) }

    try{
      const skippedNote = (impState && impState.statsAll && impState.statsAll.skippedCount)
        ? ("\n另外跳过了 " + impState.statsAll.skippedCount + " 个空会话 / 无效会话。")
        : "";
      const failedNote = result.failed ? ("\n有 " + result.failed + " 个会话解析失败被跳过。") : "";
      alert("成功导入 " + result.imported + " 个对话，共 " + result.messages + " 条消息。" + skippedNote + failedNote);
    }catch(e){ console.warn("⚠️ 提示导入结果失败", e) }

    setStatus("导入完成：新增 " + result.imported + " 个对话");
    closeImportExternal();
    return result;
  }catch(e){
    // ★ 兜底：任何未预期异常都要回滚，绝不让数据停在半截状态
    console.warn("⚠️ 导入过程出现异常，正在回滚", e);
    try{ sessions.splice(0, added) }catch(re){ console.warn("⚠️ 回滚数组失败", re) }
    try{ saveLocal() }catch(re){ console.warn("⚠️ 回滚后重新保存失败", re) }
    setStatus("导入失败，已回滚", true);
    result.imported = 0;
    result.messages = 0;
    result.failed += added;
    if(prog) prog.textContent = "❌ 导入异常，已回滚。";
    if(btn) btn.disabled = false;
    return result;
  }
}

// ★ 显式挂载到 window，方便集成与将来复用
window.LimaoImport = { detectImportFormat, convertImported, handleExternalImportFile, openImportExternal, closeImportExternal, renderImportPreview, confirmImportExternal, doImportExternal, findImportLongestChain, backtraceImportChain };