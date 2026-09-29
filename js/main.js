// ============ 应用入口 ============

function buildComboPrompt(ids) {
  if (!ids.length) return "";
  const parts = [];
  for (const id of ids) {
    const meta = skillMetaCache[id];
    if (!meta || !meta.prompt) continue;
    if (ids.length === 1) parts.push(meta.prompt);
    else parts.push(`===== 【${meta.name || id}】 =====\n${meta.prompt}`);
  }
  return parts.join("\n\n");
}

function buildComboEmo(ids) {
  const merged = {};
  for (const id of ids) {
    const meta = skillMetaCache[id];
    if (!meta || !meta.emoji) continue;
    Object.assign(merged, meta.emoji);
  }
  return merged;
}

function decideComboScope(ids) {
  if (ids.length === 1) {
    const meta = skillMetaCache[ids[0]];
    return meta && meta.scope === "all" ? "all" : "self";
  }
  return "all";
}

function refreshActiveSkills() {
  if (!currentSkillIds.length) {
    window.currentSkillPrompt = "";
    window.currentSkillEmo = {};
    currentSkillId = "";
    currentSkillName = "";
    currentSkillScope = "self";
    return;
  }
  window.currentSkillPrompt = buildComboPrompt(currentSkillIds);
  window.currentSkillEmo = buildComboEmo(currentSkillIds);
  currentSkillScope = decideComboScope(currentSkillIds);
  currentSkillId = currentSkillIds[0] || "";
  currentSkillName = currentSkillIds.map(id => (skillMetaCache[id] && skillMetaCache[id].name) || id).join(" + ");
}

function updateSkillSelectUI() {
  const sel = document.getElementById("skillSelect");
  if (!sel) return;
  if (currentSkillIds.length === 0) sel.value = "";
  else if (currentSkillIds.length === 1) sel.value = currentSkillIds[0];
  else sel.value = "__combo__";
}

function updateSkillStatus() {
  if (!currentSkillIds.length) { setStatus("已卸载 Skill"); return; }
  if (currentSkillIds.length === 1) {
    const meta = skillMetaCache[currentSkillIds[0]];
    const emoCount = meta && meta.emoji ? Object.keys(meta.emoji).length : 0;
    const scopeTag = currentSkillScope === "all" ? " · RAG:全库" : " · RAG:本Skill";
    setStatus(`已加载 Skill: ${currentSkillName}${emoCount ? ` (颜文字 ${emoCount})` : ''}${scopeTag}`);
  } else {
    const totalChars = (window.currentSkillPrompt || "").length;
    const emoCount = Object.keys(window.currentSkillEmo || {}).length;
    setStatus(`已加载 ${currentSkillIds.length} 个 Skill 组合（${totalChars} 字，颜文字 ${emoCount}）· RAG:全库`);
  }
}

async function fetchSkillMeta(skillId) {
  const res = await fetch(`${getRagUrl()}/api/skill_content?skill_id=${encodeURIComponent(skillId)}`);
  const data = await res.json();
  if (!data.content) return null;
  return { id: skillId, name: data.name || skillId, prompt: data.content || "", emoji: data.emoji || {}, scope: data.rag_scope || "self" };
}

async function setActiveSkills(ids) {
  ids = ids.filter(Boolean);
  const validIds = [];
  for (const id of ids) {
    let meta = skillMetaCache[id];
    const promptMissing = !meta || !meta.prompt;
    const emojiMissing = !meta || !meta.emoji || Object.keys(meta.emoji).length === 0;
    if (promptMissing || emojiMissing) {
      try {
        const fresh = await fetchSkillMeta(id);
        if (fresh) { skillMetaCache[id] = fresh; meta = fresh; console.log(`[Skill] 已加载 "${id}"`); }
      } catch (e) { console.warn(`[Skill] 加载 "${id}" 失败：`, e); }
    }
    if (meta && meta.prompt) validIds.push(id);
  }
  currentSkillIds = validIds;
  refreshActiveSkills();
  updateSkillSelectUI();
  updateSkillStatus();
  const totalChars = (window.currentSkillPrompt || "").length;
  if (totalChars > 12000) alert(`⚠️ 当前组合的 system prompt 已达 ${totalChars} 字，可能超出模型上下文窗口，回答质量会下降。建议减少 Skill 数量。`);
  if (typeof renderMessages === "function") { try { renderMessages(); } catch (e) { } }
}

function openSkillCombo() { const mask = document.getElementById("skillComboMask"); if (!mask) return; renderSkillCombo(); mask.classList.add("show"); }
function closeSkillCombo() { const mask = document.getElementById("skillComboMask"); if (mask) mask.classList.remove("show"); }

function renderSkillCombo() {
  const box = document.getElementById("skillComboList"); if (!box) return;
  const sel = document.getElementById("skillSelect");
  const options = Array.from(sel.options).filter(o => o.value && o.value !== "__combo__");
  if (!options.length) { box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:10px 0">没有可用的 Skill</div>'; return; }
  box.innerHTML = options.map(opt => {
    const id = opt.value;
    const checked = currentSkillIds.includes(id);
    const meta = skillMetaCache[id];
    const scope = meta ? meta.scope : "?";
    const scopeTag = scope === "all" ? '<span class="combo-scope scope-all">全库</span>' : '<span class="combo-scope scope-self">本Skill</span>';
    return `<label class="combo-item ${checked ? "checked" : ""}" data-id="${escapeHtml(id)}">
      <input type="checkbox" class="combo-cb" value="${escapeHtml(id)}" ${checked ? "checked" : ""}>
      <span class="combo-name">${escapeHtml(opt.text)}</span>${scopeTag}</label>`;
  }).join("");
  box.querySelectorAll(".combo-cb").forEach(cb => cb.onchange = () => { const label = cb.closest(".combo-item"); if (label) label.classList.toggle("checked", cb.checked); updateComboStats(); });
  updateComboStats();
}

function updateComboStats() {
  const box = document.getElementById("skillComboList");
  const stats = document.getElementById("skillComboStats");
  if (!box || !stats) return;
  const checked = Array.from(box.querySelectorAll(".combo-cb:checked")).map(cb => cb.value);
  if (checked.length === 0) { stats.textContent = "未选择任何 Skill（保存后等于卸载）"; stats.className = "combo-stats"; return; }
  let totalChars = 0, loaded = 0;
  for (const id of checked) { const meta = skillMetaCache[id]; if (meta && meta.prompt) { totalChars += meta.prompt.length; loaded++; } }
  const missing = checked.length - loaded;
  let warn = ""; let cls = "combo-stats";
  if (totalChars > 12000) { warn = " ⚠️ 过长"; cls += " warn-danger"; } else if (totalChars > 6000) { warn = " ⚠️ 偏长"; cls += " warn-mid"; }
  stats.className = cls;
  stats.textContent = `已选 ${checked.length} 个${missing ? `（${missing} 个待加载）` : ""} · 约 ${totalChars} 字${warn}`;
}

async function applySkillCombo() {
  const box = document.getElementById("skillComboList"); if (!box) return;
  const ids = Array.from(box.querySelectorAll(".combo-cb:checked")).map(cb => cb.value);
  cfg.lastSkillIds = ids.slice(); cfg.lastSkillId = ids[0] || "";
  setStatus(`正在加载 ${ids.length} 个 Skill...`);
  try { await setActiveSkills(ids); saveLocal(); } catch (e) { console.error(e); setStatus("加载 Skill 失败", true); }
  closeSkillCombo();
}

let _lastBuildStatus = "idle";
let _autoBuildNotified = false;
async function pollBuildStatus() {
  try {
    const res = await fetch(`${getRagUrl()}/api/build_status`);
    const s = await res.json();
    if (s.status !== _lastBuildStatus) {
      if (s.status === "running") {
        const trigger = s.trigger || "";
        if (trigger.startsWith("watchdog") || trigger === "startup") { _autoBuildNotified = true; setStatus(`📂 检测到文件变化，正在自动更新知识库...`); }
      } else if (s.status === "completed" && _autoBuildNotified) {
        _autoBuildNotified = false;
        const trigger = s.trigger || "";
        if (trigger.startsWith("watchdog") || trigger === "startup") {
          setStatus(`✅ 知识库已自动更新`);
          setTimeout(() => { if (!generating) updateSkillStatus(); }, 6000);
        }
      } else if (s.status === "failed" && _autoBuildNotified) {
        _autoBuildNotified = false;
        setStatus(`⚠️ 知识库自动更新失败`, true);
      }
      _lastBuildStatus = s.status;
    }
  } catch (e) { }
}

async function init() {
  window.currentSkillEmo = window.currentSkillEmo || {};
  loadLocal();
  if (!cfg.theme) cfg.theme = "dark"; if (!cfg.num_ctx) cfg.num_ctx = 8192; if (!cfg.num_predict) cfg.num_predict = 1024; if (!cfg.fontSize) cfg.fontSize = 15;
  if (!cfg.quickPrompts) cfg.quickPrompts = ["翻译", "总结", "改代码"];
  if (cfg.ragEnabled === undefined) cfg.ragEnabled = false;
  if (!cfg.ragUrl) cfg.ragUrl = DEFAULT_CFG.ragUrl;
  applyFontSize(); applyTheme();

  try { const h = await idbGet("folderHandle"); if (h) { folderHandle = h; cfg.dir = h.name; const ok = await ensureFolderPermission().catch(() => false); if (ok) await loadFromDisk(); } } catch (e) { }

  try {
    const skillRes = await fetch(`${getRagUrl()}/api/skills`);
    const skillData = await skillRes.json();
    const skillSel = document.getElementById("skillSelect");
    if (skillData && skillData.skills && skillData.skills.length > 0) {
      skillSel.innerHTML = '<option value="">（未加载Skill）</option>' + '<option value="__combo__">⚙ 多 Skill 组合...</option>' + skillData.skills.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
      skillData.skills.forEach(s => { if (!skillMetaCache[s.id]) skillMetaCache[s.id] = { id: s.id, name: s.name, prompt: "", emoji: {}, scope: s.rag_scope || "self" }; });
    }
    let restoreIds = [];
    if (Array.isArray(cfg.lastSkillIds) && cfg.lastSkillIds.length) restoreIds = cfg.lastSkillIds.slice();
    else if (cfg.lastSkillId) restoreIds = [cfg.lastSkillId];
    const validIds = new Set((skillData.skills || []).map(s => s.id));
    restoreIds = restoreIds.filter(id => validIds.has(id));
    if (restoreIds.length) await setActiveSkills(restoreIds);
  } catch (e) { console.warn("⚠️ 无法连接后端获取 Skill 列表"); }

  renderSessions(); renderPresets(); renderMessages(); renderQuickPrompts(); updateRagBadge(); restoreDraft();
  
  // ★ 核心：初始化拖拽/点击上传
  bindScrollWatcher(); 
  bindKeyboardShortcuts();
  bindDragAndDrop(); 

  updateParamBtnLabel();
  updateBreadcrumb();
  setCompareMode(cfg.compareMode || false);

  const on = (id, event, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(event, fn); else console.warn(`[UI] 元素 ${id} 不存在，已跳过绑定`); };
  
  on("newChat", "click", () => { if (generating) { alert("生成中"); return; } createSession(); renderMessages(); });
  let searchTimer = null;
  on("searchBox", "input", e => { clearTimeout(searchTimer); const v = e.target.value; searchTimer = setTimeout(() => { searchQuery = v; renderSessions(); }, 200); });
  on("starFilter", "change", e => { starFilter = e.target.checked; renderSessions(); });
  on("toggleSide", "click", () => document.getElementById("sidebar").classList.toggle("hide"));
  on("themeToggle", "click", () => { cfg.theme = cfg.theme === "dark" ? "light" : "dark"; saveLocal(); applyTheme(); });
  on("openSettings", "click", openSettings);
  on("settingsMask", "click", (e) => { if (e.target.id === "settingsMask") closeSettings(); });
  on("presetMask", "click", (e) => { if (e.target.id === "presetMask") closePresetEdit(); });
  on("regenModelMask", "click", (e) => { if (e.target.id === "regenModelMask") closeRegenModelModal(); });
  on("skillComboMask", "click", (e) => { if (e.target.id === "skillComboMask") closeSkillCombo(); });
  on("cfgTemp", "input", e => document.getElementById("tempVal").textContent = e.target.value);
  on("cfgTopP", "input", e => document.getElementById("toppVal").textContent = e.target.value);
  on("cfgFontSize", "input", e => document.getElementById("fontSizeVal").textContent = e.target.value);

  on("modelSelect", "change", e => { const val = e.target.value; if (val) { const [pid, modelName] = val.split("|"); cfg.modelProviderId = pid; cfg.model = modelName; currentProviderId = pid; saveLocal(); } });
  on("modelSelect2", "change", e => { const val = e.target.value; if (val) { const [pid, modelName] = val.split("|"); cfg.modelProviderId2 = pid; cfg.model2 = modelName; saveLocal(); } });

  on("skillSelect", "change", async (e) => {
    const skillId = e.target.value;
    if (skillId === "__combo__") { updateSkillSelectUI(); openSkillCombo(); return; }
    if (!skillId) { cfg.lastSkillIds = []; cfg.lastSkillId = ""; saveLocal(); await setActiveSkills([]); return; }
    cfg.lastSkillIds = [skillId]; cfg.lastSkillId = skillId; saveLocal(); await setActiveSkills([skillId]);
  });

  on("skillComboConfirm", "click", applySkillCombo);
  on("skillComboCancel", "click", closeSkillCombo);
  on("skillComboSelectAll", "click", () => { document.querySelectorAll("#skillComboList .combo-cb").forEach(cb => { cb.checked = true; cb.closest(".combo-item").classList.add("checked"); }); updateComboStats(); });
  on("skillComboClearAll", "click", () => { document.querySelectorAll("#skillComboList .combo-cb").forEach(cb => { cb.checked = false; cb.closest(".combo-item").classList.remove("checked"); }); updateComboStats(); });

  on("exportBtn", "click", () => { const s = getCurrentSession(); if (!s) { alert("没有对话"); return; } const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (s.title || "对话") + ".json"; a.click(); URL.revokeObjectURL(a.href); });
  on("exportMdBtn", "click", exportMarkdown);
  on("exportTxtBtn", "click", exportTxt);
  on("backupAllBtn", "click", backupAll);
  on("restoreAllBtn", "click", () => document.getElementById("restoreFile").click());
  on("restoreFile", "change", async (e) => { const f = e.target.files[0]; if (f) await restoreAll(f); e.target.value = ""; });
  on("micBtn", "click", toggleVoice);

  on("pickFolderBtn", "click", pickFolder);
  on("addTplBtn", "click", addTpl);
  on("resetTplBtn", "click", resetTpl);
  on("addPresetBtn", "click", addPreset);
  on("importPresetFolderBtn", "click", importPresetFolder);
  on("closeSettingsBtn", "click", closeSettings);
  on("saveSettingsBtn", "click", saveSettings);
  on("closePresetEditBtn", "click", closePresetEdit);
  on("savePresetEditBtn", "click", savePresetEdit);
  on("closeRegenModelModalBtn", "click", closeRegenModelModal);
  
    on("addProviderBtn", "click", () => openProviderEdit(null));
  // ★ 新增：绑定记忆管理按钮
  on("addMemoryBtn", "click", handleAddMemory);
  on("newMemoryInput", "keydown", e => { if (e.key === "Enter") handleAddMemory(); });

  on("saveSkillDirBtn", "click", async () => {
    const dir = document.getElementById("cfgSkillDir").value.trim();
    if (!dir) return alert("请输入目录路径");
    try {
      setStatus("正在更新 Skill 目录...");
      const res = await fetch(`${getRagUrl()}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skill_dir: dir }) });
      const data = await res.json();
      if (data.status === "success") {
        alert("目录已更新！正在重新加载 Skill 列表...");
        const skillRes = await fetch(`${getRagUrl()}/api/skills`); const skillData = await skillRes.json();
        const skillSel = document.getElementById("skillSelect");
        if (skillData && skillData.skills) skillSel.innerHTML = '<option value="">（未加载Skill）</option>' + '<option value="__combo__">⚙ 多 Skill 组合...</option>' + skillData.skills.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
        setStatus("Skill 目录已更新");
      }
    } catch (e) { alert("保存失败: " + e.message); setStatus("更新失败", true); }
  });

  on("rebuildRagBtn", "click", async () => {
    const btn = document.getElementById("rebuildRagBtn"); const statusText = document.getElementById("ragBuildStatus");
    const progressWrap = document.getElementById("ragProgressBarWrap"); const progressBar = document.getElementById("ragProgressBar");
    try {
      btn.disabled = true; btn.textContent = "⏳ 构建中..."; statusText.textContent = "正在启动任务...";
      progressWrap.style.display = "block"; progressBar.style.width = "0%";
      const res = await fetch(`${getRagUrl()}/api/build`, { method: "POST" }); const data = await res.json();
      if (data.status === "running") { alert("已有构建任务在运行，请稍候"); return; }
      const pollTimer = setInterval(async () => {
        try {
          const sres = await fetch(`${getRagUrl()}/api/build_status`); const sdata = await sres.json();
          if (sdata.status === "running") {
            const pct = sdata.total > 0 ? Math.round((sdata.progress / sdata.total) * 100) : 0;
            progressBar.style.width = pct + "%"; statusText.textContent = sdata.message;
          } else if (sdata.status === "completed") {
            clearInterval(pollTimer); progressBar.style.width = "100%"; statusText.textContent = sdata.message;
            btn.disabled = false; btn.textContent = "🔄 重建知识库"; alert("🎉 知识库构建完成！");
          } else if (sdata.status === "failed") {
            clearInterval(pollTimer); statusText.textContent = sdata.message; btn.disabled = false; btn.textContent = "🔄 重建知识库"; alert("❌ 构建失败：" + sdata.message);
          }
        } catch (e) { console.error(e); }
      }, 1500);
    } catch (e) { btn.disabled = false; btn.textContent = "🔄 重建知识库"; alert("请求失败：" + e.message); }
  });

  on("paramBtn", "click", openSessionParams);
  on("closeSessionParamBtn", "click", closeSessionParams);
  on("saveSessionParamBtn", "click", saveSessionParams);
  on("sessionParamMask", "click", (e) => { if (e.target.id === "sessionParamMask") closeSessionParams(); });

  on("compressBtn", "click", compressContext);
  on("compareBtn", "click", () => { setCompareMode(!cfg.compareMode); });
  on("ragBtn", "click", () => { cfg.ragEnabled = !cfg.ragEnabled; saveLocal(); updateRagBadge(); if (cfg.ragEnabled) setStatus("知识库已开启"); else setStatus("知识库已关闭"); });

  document.querySelectorAll("#accentPicker .color-swatch").forEach(s => { s.onclick = () => { document.getElementById("cfgAccent").value = s.dataset.color; document.querySelectorAll("#accentPicker .color-swatch").forEach(x => x.classList.remove("active")); s.classList.add("active"); }; });
  on("cfgAccent", "input", (e) => { document.querySelectorAll("#accentPicker .color-swatch").forEach(x => x.classList.toggle("active", (x.dataset.color || "").toLowerCase() === e.target.value.toLowerCase())); });

  const input = document.getElementById("input");
  if (input) {
    input.addEventListener("input", () => { autoResize(input); saveDraft(); });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!generating) sendMessage(); } });
  }
  on("sendBtn", "click", () => { if (generating) { if (abortCtrl) abortCtrl.abort(); } else sendMessage(); });

  window.addEventListener("beforeunload", () => { saveDraft(); try { saveLocal(); } catch (e) { } });
  
  await fetchModels(); updateCtxInfo();
  setInterval(pollBuildStatus, 3000);
  setInterval(() => { if (!generating && document.visibilityState === "visible") fetchModels(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !generating) fetchModels(); });
}

init();