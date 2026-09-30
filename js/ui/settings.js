// ============ 设置面板 + 预设 + 模板 + 颜文字 + 平台管理 + 记忆管理 ============

function openSettings() {
  fetch(`${getRagUrl()}/api/config`)
    .then(res => res.json())
    .then(data => {
      const el = document.getElementById("cfgSkillDir");
      if (el) el.value = data.skill_dir || "";
    })
    .catch(e => console.warn("获取后端配置失败", e));
  
  document.getElementById("cfgRagUrl").value = cfg.ragUrl || DEFAULT_CFG.ragUrl;
  document.getElementById("cfgDir").value = cfg.dir || "（未选择）";
  document.getElementById("cfgSys").value = cfg.system || "";
  document.getElementById("cfgTemp").value = cfg.temperature;
  document.getElementById("tempVal").textContent = cfg.temperature;
  document.getElementById("cfgTopP").value = cfg.top_p;
  document.getElementById("toppVal").textContent = cfg.top_p;
  document.getElementById("cfgCtx").value = cfg.contextRounds;
  document.getElementById("cfgNumCtx").value = cfg.num_ctx || 8192;
  document.getElementById("cfgNumPredict").value = cfg.num_predict || 1024;
  document.getElementById("cfgFontSize").value = cfg.fontSize || 15;
  document.getElementById("fontSizeVal").textContent = cfg.fontSize || 15;
  document.getElementById("cfgCompareConcurrent").checked = cfg.compareConcurrent || false;
  
  const accent = cfg.accent || "#4d6bfe";
  document.getElementById("cfgAccent").value = accent;
  document.querySelectorAll("#accentPicker .color-swatch").forEach(s => s.classList.toggle("active", s.dataset.color.toLowerCase() === accent.toLowerCase()));
  
  renderTplList();
  renderEmoList();
  renderPresets();
  renderProviderList();
  
  // ★ 新增：渲染记忆管理
  document.getElementById("cfgMemoryEnabled").checked = cfg.memoryEnabled || false;
  fetchMemories().then(() => renderMemoryList());

  // ★ 1.23：视觉输入与工具调用
  document.getElementById("cfgVisionEnabled").checked = cfg.visionEnabled !== false;
  document.getElementById("cfgImageMaxEdge").value = cfg.imageMaxEdge || 1568;
  document.getElementById("cfgToolsEnabled").checked = !!cfg.toolsEnabled;
  document.getElementById("cfgMaxToolRounds").value = cfg.maxToolRounds || 5;

  document.getElementById("settingsMask").classList.add("show");
}

function closeSettings() { document.getElementById("settingsMask").classList.remove("show"); }

function saveSettings() {
  cfg.ragUrl = document.getElementById("cfgRagUrl").value.trim().replace(/\/$/, "") || DEFAULT_CFG.ragUrl;
  cfg.system = document.getElementById("cfgSys").value;
  cfg.temperature = parseFloat(document.getElementById("cfgTemp").value);
  cfg.top_p = parseFloat(document.getElementById("cfgTopP").value);
  cfg.contextRounds = parseInt(document.getElementById("cfgCtx").value) || 20;
  cfg.num_ctx = parseInt(document.getElementById("cfgNumCtx").value) || 8192;
  cfg.num_predict = parseInt(document.getElementById("cfgNumPredict").value) || 1024;
  cfg.compareConcurrent = document.getElementById("cfgCompareConcurrent").checked;
  cfg.fontSize = parseInt(document.getElementById("cfgFontSize").value) || 15;
  cfg.accent = document.getElementById("cfgAccent").value || "";
  cfg.memoryEnabled = document.getElementById("cfgMemoryEnabled").checked; // ★ 保存记忆开关

  // ★ 1.23：视觉输入与工具调用
  cfg.visionEnabled = document.getElementById("cfgVisionEnabled").checked;
  const edge = parseInt(document.getElementById("cfgImageMaxEdge").value, 10);
  cfg.imageMaxEdge = (Number.isFinite(edge) && edge >= 256 && edge <= 4096) ? edge : 1568;
  const prevTools = !!cfg.toolsEnabled;
  cfg.toolsEnabled = document.getElementById("cfgToolsEnabled").checked;
  const rounds = parseInt(document.getElementById("cfgMaxToolRounds").value, 10);
  cfg.maxToolRounds = (Number.isFinite(rounds) && rounds >= 1 && rounds <= 20) ? rounds : 5;

  saveLocal();
  applyFontSize();
  applyAccentColor();
  // ★ 1.23：工具开关可能被改动，同步顶栏徽章
  if (typeof updateToolsBadge === "function") updateToolsBadge();
  if (prevTools !== cfg.toolsEnabled) {
    setStatus(cfg.toolsEnabled ? "🔧 工具调用已开启" : "工具调用已关闭");
  }
  closeSettings();
  fetchModels();
  updateCtxInfo();
  if (typeof updateParamBtnLabel === "function") updateParamBtnLabel();
}

// ============ ★ 记忆管理 UI ============

function renderMemoryList() {
  const box = document.getElementById("memoryList");
  if (!box) return;
  if (!memories || memories.length === 0) {
    box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px 0;">还没有记忆，在下方输入一条吧</div>';
    return;
  }
  box.innerHTML = memories.map((m, i) => `
    <div class="memory-item" style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border-bottom:1px solid var(--border); font-size:13px;">
      <div style="flex:1; min-width:0; word-break:break-all; margin-right:8px;">
        ${escapeHtml(m.content)}
        <div style="font-size:11px; color:var(--text-dim); margin-top:2px;">来源：${escapeHtml(m.source || '未知')}</div>
      </div>
      <button class="del-memory-btn" data-id="${m.id}" style="padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:transparent; color:#e34b4b; cursor:pointer; font-size:11px; flex-shrink:0;">删除</button>
    </div>
  `).join("");
  
  box.querySelectorAll(".del-memory-btn").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm("确定删除这条记忆吗？")) return;
      await deleteMemory(id);
      memories = memories.filter(m => m.id !== id);
      renderMemoryList();
      setStatus("已删除记忆");
    };
  });
}

async function handleAddMemory() {
  const input = document.getElementById("newMemoryInput");
  const content = input.value.trim();
  if (!content) return;
  setStatus("正在添加记忆...");
  const res = await addMemory(content, "手动添加");
  if (res) {
    input.value = "";
    await fetchMemories();
    renderMemoryList();
    setStatus("记忆已添加");
  } else {
    setStatus("添加记忆失败", true);
  }
}

// ============ 平台管理 ============

function renderProviderList() {
  const box = document.getElementById("providerList");
  if (!box) return;
  if (!cfg.providers || !cfg.providers.length) {
    box.innerHTML = '<div style="color:var(--text-dim);font-size:13px">暂无平台，请点击下方新增</div>';
    return;
  }
  box.innerHTML = cfg.providers.map(p => `
    <div class="provider-item" style="border:1px solid var(--border); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:6px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong style="font-size:13px;">${escapeHtml(p.name)} <span style="color:var(--text-dim); font-weight:normal; font-size:11px;">(${p.type})</span></strong>
        <div>
          <button class="provider-test-btn" data-id="${p.id}" style="padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:transparent; color:var(--text-dim); cursor:pointer; font-size:11px; margin-right:4px;">测试连接</button>
          <button class="provider-edit-btn" data-id="${p.id}" style="padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:transparent; color:var(--text-dim); cursor:pointer; font-size:11px; margin-right:4px;">编辑</button>
          <button class="provider-del-btn" data-id="${p.id}" style="padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:transparent; color:#e34b4b; cursor:pointer; font-size:11px;">删除</button>
        </div>
      </div>
      <div style="font-size:12px; color:var(--text-dim); word-break:break-all;">${escapeHtml(p.baseUrl)}</div>
      <div class="provider-test-result" data-id="${p.id}" style="font-size:11px; display:none; padding:4px; border-radius:4px;"></div>
    </div>
  `).join("");

  box.querySelectorAll(".provider-test-btn").forEach(btn => {
    btn.onclick = async () => {
      const pid = btn.dataset.id;
      const p = cfg.providers.find(x => x.id === pid);
      if (!p) return;
      const resultDiv = box.querySelector(`.provider-test-result[data-id="${pid}"]`);
      resultDiv.style.display = "block";
      resultDiv.style.background = "var(--hover)";
      resultDiv.style.color = "var(--text)";
      resultDiv.textContent = "⏳ 测试中...";
      const res = await testProviderConnection(p);
      if (res.ok) {
        resultDiv.style.background = "rgba(16,163,127,.15)";
        resultDiv.style.color = "#10a37f";
        resultDiv.textContent = "✅ " + res.msg;
      } else {
        resultDiv.style.background = "rgba(227,75,75,.12)";
        resultDiv.style.color = "#e34b4b";
        resultDiv.textContent = "❌ " + res.msg;
      }
    };
  });

  box.querySelectorAll(".provider-edit-btn").forEach(btn => {
    btn.onclick = () => openProviderEdit(btn.dataset.id);
  });

  box.querySelectorAll(".provider-del-btn").forEach(btn => {
    btn.onclick = () => {
      if (!confirm("确定删除这个平台吗？")) return;
      cfg.providers = cfg.providers.filter(x => x.id !== btn.dataset.id);
      if (cfg.providers.length === 0) {
        cfg.providers.push({ id: "ollama", type: "ollama", name: "本地 Ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "" });
      }
      saveLocal();
      renderProviderList();
      fetchModels();
    };
  });
}

function openProviderEdit(providerId) {
  const p = providerId ? cfg.providers.find(x => x.id === providerId) : null;
  editingProviderId = providerId;
  
  const name = prompt("平台名称（例如：DeepSeek）：", p ? p.name : "DeepSeek");
  if (name === null) return;
  const baseUrl = prompt("API 地址（例如：https://api.deepseek.com）：", p ? p.baseUrl : "https://api.deepseek.com");
  if (baseUrl === null) return;
  const type = prompt("类型（填 ollama 或 openai）：", p ? p.type : "openai");
  if (type === null) return;
  const apiKey = prompt("API Key（Ollama 可留空）：", p ? p.apiKey : "");
  if (apiKey === null) return;

  if (editingProviderId) {
    const existing = cfg.providers.find(x => x.id === editingProviderId);
    existing.name = name;
    existing.baseUrl = baseUrl;
    existing.type = type;
    existing.apiKey = apiKey;
  } else {
    cfg.providers.push({
      id: "p" + Date.now(),
      name, baseUrl, type, apiKey
    });
  }
  saveLocal();
  renderProviderList();
  fetchModels();
}

// ============ 预设列表 ============
// ★ 修复（16）：1.22/1.23 一直存在"预设层是死功能"的问题——
//   currentPresetId 全项目只有"删除时清空"一处写入，从来没有赋值入口，
//   所以预设的参数覆盖与 system prompt 永远不会生效，参数继承实际退化为「会话 → 全局」。
//   这里补上真正的启用入口，并把选择持久化到 cfg.activePresetId。
function getActivePreset() {
  if (!currentPresetId) return null;
  return presets.find(x => x.id === currentPresetId) || null;
}

function setActivePreset(id) {
  const p = id ? presets.find(x => x.id === id) : null;
  currentPresetId = p ? p.id : "";
  cfg.activePresetId = currentPresetId;
  saveLocal();
  renderPresets();
  if (typeof updatePresetBadge === "function") updatePresetBadge();
  if (typeof updateParamBtnLabel === "function") updateParamBtnLabel();
  if (typeof renderMessages === "function") { try { renderMessages(); } catch (e) { } }
  if (p) {
    const n = p.params ? Object.keys(p.params).length : 0;
    setStatus(`已启用预设：${p.name}${n ? `（覆盖 ${n} 项参数）` : ""}`);
  } else {
    setStatus("已取消预设，回到全局设置");
  }
}

function renderPresets() {
  const list = document.getElementById("presetList");
  if (!list) return;
  if (!presets.length) { list.innerHTML = '<div style="color:var(--text-dim);font-size:13px">还没有预设</div>'; return; }
  list.innerHTML = presets.map(p => {
    const promptLen = (p.prompt || "").length;
    const paramCount = p.params ? Object.keys(p.params).length : 0;
    const paramTag = paramCount ? `<span style="color:var(--accent);font-size:12px;margin-left:6px">⚙ ${paramCount}项参数</span>` : "";
    const active = (p.id === currentPresetId);
    const activeTag = active ? `<span style="color:#10a37f;font-size:12px;margin-left:6px">● 使用中</span>` : "";
    const useBtn = active
      ? `<button data-unuse="1" title="取消使用该预设">停用</button>`
      : `<button data-use="${escapeHtml(p.id)}" title="启用该预设：其 system prompt 与参数覆盖将生效">启用</button>`;
    return `<div class="preset-item${active ? " preset-active" : ""}"><span>${escapeHtml(p.name)}<span style="color:var(--text-dim);font-size:12px;margin-left:8px">(${promptLen} 字)</span>${paramTag}${activeTag}</span><span>${useBtn}<button data-edit="${escapeHtml(p.id)}">编辑</button><button data-del="${escapeHtml(p.id)}">删除</button></span></div>`;
  }).join("");
  list.querySelectorAll("[data-use]").forEach(b => b.onclick = () => setActivePreset(b.dataset.use));
  list.querySelectorAll("[data-unuse]").forEach(b => b.onclick = () => setActivePreset(""));
  list.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editPreset(b.dataset.edit));
  list.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    if (!confirm("删除？")) return;
    const wasActive = (currentPresetId === b.dataset.del);
    presets = presets.filter(x => x.id !== b.dataset.del);
    if (wasActive) { currentPresetId = ""; cfg.activePresetId = ""; }
    saveLocal(); saveToDisk(); renderPresets();
    if (wasActive && typeof updatePresetBadge === "function") updatePresetBadge();
    if (typeof updateParamBtnLabel === "function") updateParamBtnLabel();
  });
}

// 恢复上次启用的预设（在 init() 里调用）
function restoreActivePreset() {
  const id = cfg.activePresetId || "";
  if (id && presets.some(p => p.id === id)) {
    currentPresetId = id;
  } else {
    currentPresetId = "";
    if (id) { cfg.activePresetId = ""; saveLocal(); }
  }
  if (typeof updatePresetBadge === "function") updatePresetBadge();
}

// 顶栏显示当前预设（复用会话参数按钮旁边的一个小徽章）
function updatePresetBadge() {
  const el = document.getElementById("presetBadge");
  if (!el) return;
  const p = getActivePreset();
  if (p) {
    el.textContent = "🎭 " + p.name;
    el.style.display = "inline-flex";
    el.title = "当前启用的预设：" + p.name + "（点击可停用）";
  } else {
    el.textContent = "";
    el.style.display = "none";
  }
}
function addPreset() {
  editingPresetId = null;
  document.getElementById("presetTitle").textContent = "新建预设";
  document.getElementById("presetName").value = "";
  document.getElementById("presetPrompt").value = "";
  renderPresetParams({});
  document.getElementById("presetMask").classList.add("show");
}
function editPreset(id) {
  const p = presets.find(x => x.id === id);
  if (!p) return;
  editingPresetId = id;
  document.getElementById("presetTitle").textContent = "编辑预设";
  document.getElementById("presetName").value = p.name;
  document.getElementById("presetPrompt").value = p.prompt;
  renderPresetParams(p.params || {});
  document.getElementById("presetMask").classList.add("show");
}
function closePresetEdit() { document.getElementById("presetMask").classList.remove("show"); }
function savePresetEdit() {
  const name = document.getElementById("presetName").value.trim();
  const prompt = document.getElementById("presetPrompt").value;
  if (!name) { alert("请填写名称"); return; }

  const params = {};
  PARAM_KEYS.forEach(k => {
    const cb = document.querySelector(`#presetParamBody .preset-param-override[data-key="${k}"]`);
    if (cb && cb.checked) {
      const inp = document.querySelector(`#presetParamBody .preset-param-num[data-key="${k}"]`);
      if (inp && inp.value !== "") params[k] = parseFloat(inp.value);
    }
  });

  if (editingPresetId) {
    const p = presets.find(x => x.id === editingPresetId);
    p.name = name;
    p.prompt = prompt;
    p.params = Object.keys(params).length ? params : undefined;
  } else {
    presets.push({ id: "p" + Date.now(), name, prompt, params: Object.keys(params).length ? params : undefined });
  }
  saveLocal(); saveToDisk(); renderPresets(); closePresetEdit();
}
async function importPresetFolder() {
  try {
    const dir = await window.showDirectoryPicker({ mode: "read" });
    const allFiles = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file") {
        const nm = entry.name.toLowerCase();
        if (/\.(md|markdown|txt|text)$/i.test(nm)) { const f = await entry.getFile(); if (f.size > 500 * 1024) continue; allFiles.push({ name: entry.name, file: f }); }
      }
    }
    if (!allFiles.length) { alert("没有 .md / .txt 文件。"); return; }
    let chosen = allFiles.filter(x => /^skill\.(md|markdown|txt)$/i.test(x.name));
    if (!chosen.length) {
      const blacklist = /^(license|licence|changelog|contributing|security|code_of_conduct|code-of-conduct|gitignore|\.gitignore)/i;
      chosen = allFiles.filter(x => !blacklist.test(x.name));
      chosen.sort((a, b) => (/^readme/i.test(a.name) ? 1 : 0) - (/^readme/i.test(b.name) ? 1 : 0));
    }
    const used = chosen.slice(0, 3);
    let combined = "";
    for (const item of used) { const txt = await item.file.text(); if (used.length > 1) combined += `\n\n### 来自 ${item.name}\n${txt}`; else combined += txt; }
    const name = prompt("给这个预设起个名字：", dir.name); if (!name) return;
    presets.push({ id: "p" + Date.now(), name, prompt: combined.trim() });
    saveLocal(); saveToDisk(); renderPresets();
    alert("导入成功！共读取 " + used.length + " 个文件：" + used.map(x => "\n• " + x.name).join("") + "\n\n总字数：" + combined.length);
  } catch (e) { if (e.name !== "AbortError") alert("失败：" + e.message); }
}

// ============ 提示词模板 ============
function renderTplList() {
  const box = document.getElementById("tplList"); if (!box) return;
  if (!cfg.quickPrompts.length) {
    box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:4px 0">还没有模板</div>';
    return;
  }
  const varsHint = `<div class="tpl-vars-hint">
    <div style="margin-bottom:6px">💡 点击变量可插入到下方输入框，模板里同时支持中文和英文写法：</div>
    <button class="tpl-var-chip" data-var="{{date}}">📅 日期 <code>{{date}}</code></button>
    <button class="tpl-var-chip" data-var="{{time}}">🕐 时间 <code>{{time}}</code></button>
    <button class="tpl-var-chip" data-var="{{session_title}}">💬 会话标题 <code>{{session_title}}</code></button>
    <button class="tpl-var-chip" data-var="{{selected}}">✂️ 选中文本 <code>{{selected}}</code></button>
    <button class="tpl-var-chip" data-var="{{clipboard}}">📋 剪贴板 <code>{{clipboard}}</code></button>
    <div style="margin-top:6px;font-size:11px;opacity:.8">中文写法同样有效：{{日期}}、{{时间}}、{{会话标题}}、{{选中}}、{{剪贴板}}</div>
  </div>`;
  box.innerHTML = varsHint + cfg.quickPrompts.map((p, i) => `<div class="tpl-row"><input type="text" class="tpl-input" data-idx="${i}" value="${escapeHtml(p)}" placeholder="模板文字，支持 {{date}} 或 {{日期}} 等变量"><button class="tpl-up" data-idx="${i}" title="上移" ${i === 0 ? "disabled" : ""}>↑</button><button class="tpl-down" data-idx="${i}" title="下移" ${i === cfg.quickPrompts.length - 1 ? "disabled" : ""}>↓</button><button class="tpl-del" data-idx="${i}" title="删除">🗑</button></div>`).join("");
  
  box.querySelectorAll(".tpl-input").forEach(inp => {
    inp.onfocus = () => { lastTplInputIdx = parseInt(inp.dataset.idx); };
    inp.oninput = () => { const i = parseInt(inp.dataset.idx); cfg.quickPrompts[i] = inp.value; saveLocal(); renderQuickPrompts(); };
  });
  box.querySelectorAll(".tpl-var-chip").forEach(chip => chip.onclick = () => {
    if (lastTplInputIdx < 0) { alert("请先点击一个模板输入框，再点变量"); return; }
    const inp = box.querySelector(`.tpl-input[data-idx="${lastTplInputIdx}"]`);
    if (!inp) return;
    const v = chip.dataset.var;
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    inp.value = inp.value.slice(0, start) + v + inp.value.slice(end);
    cfg.quickPrompts[lastTplInputIdx] = inp.value;
    saveLocal(); renderQuickPrompts();
    inp.focus();
    inp.setSelectionRange(start + v.length, start + v.length);
  });
  box.querySelectorAll(".tpl-up").forEach(b => b.onclick = () => moveTpl(parseInt(b.dataset.idx), -1));
  box.querySelectorAll(".tpl-down").forEach(b => b.onclick = () => moveTpl(parseInt(b.dataset.idx), 1));
  box.querySelectorAll(".tpl-del").forEach(b => b.onclick = () => delTpl(parseInt(b.dataset.idx)));
}
function moveTpl(i, d) { const j = i + d; if (j < 0 || j >= cfg.quickPrompts.length) return; [cfg.quickPrompts[i], cfg.quickPrompts[j]] = [cfg.quickPrompts[j], cfg.quickPrompts[i]]; saveLocal(); renderTplList(); renderQuickPrompts(); }
function delTpl(i) { if (!confirm("删除这个模板？")) return; cfg.quickPrompts.splice(i, 1); saveLocal(); renderTplList(); renderQuickPrompts(); }
function addTpl() { cfg.quickPrompts.push("新模板"); saveLocal(); renderTplList(); renderQuickPrompts(); setTimeout(() => { const inputs = document.querySelectorAll("#tplList .tpl-input"); const last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); } }, 50); }
function resetTpl() { if (!confirm("恢复默认三个模板（翻译、总结、改代码）？")) return; cfg.quickPrompts = ["翻译", "总结", "改代码"]; saveLocal(); renderTplList(); renderQuickPrompts(); }

// ============ 颜文字 ============
function renderEmoList() {
  const box = document.getElementById("emoList"); if (!box) return;
  const map = getEmoMap(); const keys = Object.keys(map);
  if (!keys.length) { box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:4px 0">还没有颜文字，点下面新增一个</div>'; return; }
  box.innerHTML = keys.map((k, i) => `<div class="emo-row" data-i="${i}"><input type="text" class="emo-key" value="${escapeHtml(k)}" placeholder="标签" spellcheck="false"><input type="text" class="emo-val" value="${escapeHtml(map[k])}" placeholder="颜文字" spellcheck="false"><button class="del" title="删除">🗑</button></div>`).join("");
  box.querySelectorAll(".emo-row").forEach(row => {
    const i = parseInt(row.dataset.i); const oldKey = keys[i]; const keyInp = row.querySelector(".emo-key"); const valInp = row.querySelector(".emo-val");
    const commit = (newKey, newVal) => { const curMap = getEmoMap(); if (oldKey !== newKey) { delete curMap[oldKey]; } curMap[newKey] = newVal; cfg.emoMap = curMap; saveLocal(); renderEmoList(); };
    keyInp.onchange = () => { const raw = keyInp.value.trim(); const nk = raw.replace(/[^a-zA-Z0-9_]/g, ""); if (!nk) { alert("标签只能用英文、数字、下划线"); renderEmoList(); return; } if (nk !== raw) alert("标签只能用英文、数字、下划线，已自动过滤为：" + nk); commit(nk, valInp.value); };
    valInp.oninput = () => { const m = getEmoMap(); m[oldKey] = valInp.value; cfg.emoMap = m; saveLocal(); };
    row.querySelector(".del").onclick = () => { if (!confirm(`删除标签 ${oldKey}？`)) return; const m = getEmoMap(); delete m[oldKey]; cfg.emoMap = m; saveLocal(); renderEmoList(); renderMessages(); };
  });
}
function addEmo() { const m = getEmoMap(); let n = 1, key = "new"; while (m[key]) { n++; key = "new" + n; } m[key] = "(・_・)"; cfg.emoMap = m; saveLocal(); renderEmoList(); setTimeout(() => { const rows = document.querySelectorAll("#emoList .emo-row"); const last = rows[rows.length - 1]; if (last) { const k = last.querySelector(".emo-key"); k.focus(); k.select(); } }, 50); }
async function resetEmo() {
  if (!confirm("确定要从后端重新拉取颜文字库吗？（会覆盖你本地修改的）")) return;
  // ★ 修复（14）：/api/emoji 现在后端真的存在了（此前只会 404）。
  //   当前加载了 Skill 时优先拉该 Skill 的 emoji_config.json，
  //   否则退回 skill_dir 根目录的那一份。
  const target = (typeof currentSkillIds !== "undefined" && currentSkillIds.length === 1) ? currentSkillIds[0] : "";
  try {
    const url = `${getRagUrl()}/api/emoji` + (target ? `?skill_id=${encodeURIComponent(target)}` : "");
    const emojiRes = await fetch(url);
    if (!emojiRes.ok) { alert(`拉取失败：HTTP ${emojiRes.status}`); return; }
    const emojiData = await emojiRes.json();
    if (emojiData.emoji && Object.keys(emojiData.emoji).length > 0) {
      cfg.emoMap = emojiData.emoji;
      dynamicEmo = emojiData.emoji;
      saveLocal(); renderEmoList(); renderMessages();
      alert(`已从后端重新加载 ${Object.keys(emojiData.emoji).length} 条颜文字！`);
    } else {
      alert("后端返回为空。\n\n" + (emojiData.error || "") +
        "\n\n请检查：" + (emojiData.path || `${target ? target + "/" : ""}emoji_config.json`));
    }
  } catch (e) { alert("拉取失败，请确认 RAG 秘书（Python黑框）已启动。"); }
}

// ============ 预设参数覆盖区 ============
function renderPresetParams(currentParams) {
  const box = document.getElementById("presetParamBody");
  if (!box) return;
  const labels = {
    temperature: { label: "Temperature", min: 0, max: 2, step: 0.1, def: cfg.temperature },
    top_p: { label: "Top P", min: 0, max: 1, step: 0.05, def: cfg.top_p },
    num_ctx: { label: "num_ctx", min: 512, max: 131072, step: 512, def: cfg.num_ctx || 8192 },
    num_predict: { label: "num_predict", min: 64, max: 8192, step: 64, def: cfg.num_predict || 1024 }
  };
  box.innerHTML = PARAM_KEYS.map(k => {
    const info = labels[k];
    const overridden = hasValue(currentParams[k]);
    const val = overridden ? currentParams[k] : info.def;
    return `<div class="param-field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" class="preset-param-override" data-key="${k}" ${overridden ? "checked" : ""}>
        <span>${info.label}</span>
      </label>
      <div class="param-row">
        <input type="range" class="preset-param-range" data-key="${k}" min="${info.min}" max="${info.max}" step="${info.step}" value="${val}">
        <input type="number" class="preset-param-num" data-key="${k}" min="${info.min}" max="${info.max}" step="${info.step}" value="${val}">
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll(".preset-param-range").forEach(r => r.oninput = () => {
    const num = box.querySelector(`.preset-param-num[data-key="${r.dataset.key}"]`);
    if (num) num.value = r.value;
  });
  box.querySelectorAll(".preset-param-num").forEach(n => n.oninput = () => {
    const range = box.querySelector(`.preset-param-range[data-key="${n.dataset.key}"]`);
    if (range) range.value = n.value;
  });
}

// ============ 会话级参数弹窗 ============
function openSessionParams() {
  const s = getCurrentSession();
  if (!s) { alert("请先创建一个对话"); return; }
  editingSessionParams = s.params ? { ...s.params } : {};
  renderSessionParamsModal();
  document.getElementById("sessionParamMask").classList.add("show");
}
function closeSessionParams() {
  document.getElementById("sessionParamMask").classList.remove("show");
  editingSessionParams = null;
}
function renderSessionParamsModal() {
  const box = document.getElementById("sessionParamBody");
  if (!box) return;
  if (!editingSessionParams) editingSessionParams = {};
  const labels = {
    temperature: { label: "Temperature", min: 0, max: 2, step: 0.1 },
    top_p: { label: "Top P", min: 0, max: 1, step: 0.05 },
    num_ctx: { label: "num_ctx 上下文窗口", min: 512, max: 131072, step: 512 },
    num_predict: { label: "num_predict 最大输出", min: 64, max: 8192, step: 64 }
  };
  const srcTag = (src) => {
    if (src === "session") return '<span class="param-src src-session">会话</span>';
    if (src === "preset") return '<span class="param-src src-preset">预设</span>';
    return '<span class="param-src src-global">全局</span>';
  };
  box.innerHTML = PARAM_KEYS.map(k => {
    const info = labels[k];
    const resolved = resolveParam(k);
    const overridden = hasValue(editingSessionParams[k]);
    const val = overridden ? editingSessionParams[k] : resolved.value;
    return `<div class="field param-field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" class="param-override" data-key="${k}" ${overridden ? "checked" : ""}>
        <span>${info.label}</span>
        ${srcTag(resolved.source)}
      </label>
      <div class="param-row">
        <input type="range" class="param-range" data-key="${k}" min="${info.min}" max="${info.max}" step="${info.step}" value="${val}">
        <input type="number" class="param-num" data-key="${k}" min="${info.min}" max="${info.max}" step="${info.step}" value="${val}">
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll(".param-override").forEach(cb => cb.onchange = () => {
    const k = cb.dataset.key;
    if (cb.checked) {
      const resolved = resolveParam(k);
      editingSessionParams[k] = resolved.value;
    } else {
      delete editingSessionParams[k];
    }
    renderSessionParamsModal();
  });
  box.querySelectorAll(".param-range").forEach(r => r.oninput = () => {
    const k = r.dataset.key;
    const num = box.querySelector(`.param-num[data-key="${k}"]`);
    if (num) num.value = r.value;
  });
  box.querySelectorAll(".param-num").forEach(n => n.oninput = () => {
    const k = n.dataset.key;
    const range = box.querySelector(`.param-range[data-key="${k}"]`);
    if (range) range.value = n.value;
  });
}
function saveSessionParams() {
  const s = getCurrentSession();
  if (!s) return;
  const box = document.getElementById("sessionParamBody");
  if (!box) return;
  const final = {};
  PARAM_KEYS.forEach(k => {
    const cb = box.querySelector(`.param-override[data-key="${k}"]`);
    if (cb && cb.checked) {
      const num = box.querySelector(`.param-num[data-key="${k}"]`);
      if (num && num.value !== "") {
        final[k] = parseFloat(num.value);
      }
    }
  });
  s.params = Object.keys(final).length ? final : undefined;
  s.updatedAt = Date.now();
  saveLocal(); saveToDisk();
  updateParamBtnLabel();
  updateCtxInfo();
  setStatus("会话参数已保存");
  closeSessionParams();
}
function updateParamBtnLabel() {
  const s = getCurrentSession();
  const btn = document.getElementById("paramBtn");
  if (!btn) return;
  const hasOverride = s && s.params && Object.keys(s.params).length > 0;
  btn.classList.toggle("on", !!hasOverride);
  btn.textContent = hasOverride ? "🌡️ 参数*" : "🌡️ 参数";
}