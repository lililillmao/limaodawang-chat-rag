// ============ 通用工具函数 ============
// 从 index.html 中抽离，保持全局可用

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}

function estimateTokens(t){
  if(!t) return 0;
  const c = (t.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length;
  return Math.round(c * 0.6 + (t.length - c) * 0.3);
}

function formatTime(ts){
  if(!ts) return "";
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
}

function copyText(text, btn){
  if(!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "✓";
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 1200);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try{
      document.execCommand("copy");
      btn.textContent = "✓";
      btn.classList.add("ok");
      setTimeout(() => { btn.textContent = "📋"; btn.classList.remove("ok"); }, 1200);
    }catch(e){}
    document.body.removeChild(ta);
  });
}

function darkenHex(hex, amt){
  try{
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.round(r * (1 - amt)));
    g = Math.max(0, Math.round(g * (1 - amt)));
    b = Math.max(0, Math.round(b * (1 - amt)));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }catch(e){ return hex; }
}

function lightenHex(hex, amt){
  try{
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, Math.round(r + (255 - r) * amt));
    g = Math.min(255, Math.round(g + (255 - g) * amt));
    b = Math.min(255, Math.round(b + (255 - b) * amt));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }catch(e){ return hex; }
}
function setStatus(txt, err){
  document.getElementById("status").innerHTML =
    `<span class="status-dot${err ? " err" : ""}"></span>${escapeHtml(txt)}`;
}

// ============ ★ 1.23 新增：通用辅助 ============

// 从 baseUrl 推断一个 OpenAI 兼容平台默认的对话端点
// 有些平台给的地址是完整的 .../v1/chat/completions，此时直接用，避免拼成 .../v1/chat/completions/v1/chat/completions
function resolveOpenAIEndpoint(baseUrl){
  const b = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + "/chat/completions";
  if (/\/v\d+\//.test(b)) return b.replace(/\/+$/, "");
  return b + "/v1/chat/completions";
}

// 安全取值：把可能是 undefined/null 的 token 数归一成数字
function toTokenNum(v){
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// ============ 会话分支树辅助 ============

function getSessionById(id){
  return sessions.find(s => s.id === id) || null;
}

// 从根到当前会话的完整链（根在前）
function getSessionChain(id){
  const chain = [];
  const seen = new Set();
  let cur = getSessionById(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentSessionId ? getSessionById(cur.parentSessionId) : null;
  }
  return chain;
}

// 会话深度：根为 0
function getSessionDepth(id){
  return Math.max(0, getSessionChain(id).length - 1);
}

// 会话的直接子分支
function getSessionChildren(id){
  return sessions.filter(s => s.parentSessionId === id);
}

// ============ 模板变量解析 ============
// 同时支持英文和中文两种写法：
//   {{date}} / {{日期}}
//   {{time}} / {{时间}}
//   {{session_title}} / {{会话标题}} / {{标题}}
//   {{selected}} / {{选中}} / {{选中文本}}
//   {{clipboard}} / {{剪贴板}}

// 监听选区变化，只保留非空值
// 点击按钮后选区会变空，所以不能用实时 selection
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  const t = sel ? sel.toString() : "";
  if (t) cachedSelection = t;
});

async function resolveTemplateVars(text) {
  if (!text) return text;
  let result = text;

  // 日期 / 时间
  const now = new Date();
  const dateStr = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  const timeStr = String(now.getHours()).padStart(2, "0") + ":" +
    String(now.getMinutes()).padStart(2, "0");
  result = result.replace(/\{\{\s*(?:date|日期)\s*\}\}/g, dateStr);
  result = result.replace(/\{\{\s*(?:time|时间)\s*\}\}/g, timeStr);

  // 会话标题
  if (/\{\{\s*(?:session_title|会话标题|标题)\s*\}\}/.test(result)) {
    const s = getCurrentSession();
    const title = s ? (s.title || "") : "";
    result = result.replace(/\{\{\s*(?:session_title|会话标题|标题)\s*\}\}/g, title);
  }

  // 选中文本
  if (/\{\{\s*(?:selected|选中|选中文本)\s*\}\}/.test(result)) {
    let selText = cachedSelection || "";
    if (!selText) {
      const sel = window.getSelection();
      selText = sel ? sel.toString() : "";
    }
    result = result.replace(/\{\{\s*(?:selected|选中|选中文本)\s*\}\}/g, selText);
  }

  // 剪贴板
  if (/\{\{\s*(?:clipboard|剪贴板)\s*\}\}/.test(result)) {
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch (e) {
      console.warn("读取剪贴板失败（可能需要权限或非 localhost）", e);
    }
    result = result.replace(/\{\{\s*(?:clipboard|剪贴板)\s*\}\}/g, clip);
  }

  return result;
}