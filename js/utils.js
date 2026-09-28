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