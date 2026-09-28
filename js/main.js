// ============ 应用入口 ============

async function init(){
  window.currentSkillEmo = window.currentSkillEmo || {};
  loadLocal();
  if(!cfg.theme)cfg.theme="dark";if(!cfg.num_ctx)cfg.num_ctx=8192;if(!cfg.num_predict)cfg.num_predict=1024;if(!cfg.fontSize)cfg.fontSize=15;
  if(!cfg.quickPrompts)cfg.quickPrompts=["翻译","总结","改代码"];
  if(cfg.ragEnabled===undefined)cfg.ragEnabled=false;
  if(!cfg.ragUrl)cfg.ragUrl=DEFAULT_CFG.ragUrl;
  applyFontSize();applyTheme();

  try{const h=await idbGet("folderHandle");if(h){folderHandle=h;cfg.dir=h.name;const ok=await ensureFolderPermission().catch(()=>false);if(ok)await loadFromDisk()}}catch(e){}

  try {
    const skillRes = await fetch(`${getRagUrl()}/api/skills`);
    const skillData = await skillRes.json();
    const skillSel = document.getElementById("skillSelect");
    if (skillData && skillData.skills && skillData.skills.length > 0) {
      skillSel.innerHTML = '<option value="">（未加载Skill）</option>' +
        skillData.skills.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
    }
  } catch(e) {console.warn("⚠️ 无法连接后端获取 Skill 列表");}

  renderSessions();renderPresets();renderMessages();renderQuickPrompts();updateRagBadge();restoreDraft();bindScrollWatcher();bindKeyboardShortcuts();
  setCompareMode(cfg.compareMode || false);

  document.getElementById("newChat").onclick=()=>{if(generating){alert("生成中");return}createSession();renderMessages()};
  let searchTimer=null;
  document.getElementById("searchBox").addEventListener("input",e=>{clearTimeout(searchTimer);const v=e.target.value;searchTimer=setTimeout(()=>{searchQuery=v;renderSessions();},200);});
  document.getElementById("starFilter").addEventListener("change",e=>{starFilter=e.target.checked;renderSessions()});
  document.getElementById("toggleSide").onclick=()=>document.getElementById("sidebar").classList.toggle("hide");
  document.getElementById("themeToggle").onclick=()=>{cfg.theme=cfg.theme==="dark"?"light":"dark";saveLocal();applyTheme()};
  document.getElementById("openSettings").onclick=openSettings;
  document.getElementById("settingsMask").onclick=(e)=>{if(e.target.id==="settingsMask")closeSettings()};
  document.getElementById("presetMask").onclick=(e)=>{if(e.target.id==="presetMask")closePresetEdit()};
  document.getElementById("regenModelMask").onclick=(e)=>{if(e.target.id==="regenModelMask")closeRegenModelModal()};
  document.getElementById("cfgTemp").oninput=e=>document.getElementById("tempVal").textContent=e.target.value;
  document.getElementById("cfgTopP").oninput=e=>document.getElementById("toppVal").textContent=e.target.value;
  document.getElementById("cfgFontSize").oninput=e=>document.getElementById("fontSizeVal").textContent=e.target.value;
  
  document.getElementById("modelSelect").onchange=e=>{cfg.model=e.target.value;saveLocal()};
  document.getElementById("modelSelect2").onchange=e=>{cfg.model2=e.target.value;saveLocal()};
  
  document.getElementById("skillSelect").onchange = async (e) => {
      const skillId = e.target.value;
      if (!skillId) {
    window.currentSkillPrompt = "";
    window.currentSkillEmo = {};
    currentSkillId = "";
    currentSkillName = "";
    setStatus("已卸载 Skill");
    return;
}
      try {
          setStatus("正在加载 Skill...");
          const res = await fetch(`${getRagUrl()}/api/skill_content?skill_id=${encodeURIComponent(skillId)}`);
          const data = await res.json();
          if (data.content) {
    window.currentSkillPrompt = data.content;
    window.currentSkillEmo = data.emoji || {};
    currentSkillId = skillId;
    const _sel = document.getElementById("skillSelect");
    currentSkillName = (_sel.options[_sel.selectedIndex] && _sel.options[_sel.selectedIndex].text) || skillId;
    const _emoCount = Object.keys(window.currentSkillEmo).length;
    setStatus(`已加载 Skill: ${currentSkillName}${_emoCount ? ` (颜文字 ${_emoCount})` : ''}`);
} else {
    window.currentSkillPrompt = "";
    window.currentSkillEmo = {};
    currentSkillId = "";
    currentSkillName = "";
    setStatus("加载 Skill 失败", true);
}
      } catch (err) {
          console.error(err);
          setStatus("请求 Skill 内容失败", true);
      }
  };
  
  document.getElementById("exportBtn").onclick=()=>{const s=getCurrentSession();if(!s){alert("没有对话");return}const blob=new Blob([JSON.stringify(s,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(s.title||"对话")+".json";a.click();URL.revokeObjectURL(a.href)};
  document.getElementById("exportMdBtn").onclick=exportMarkdown;
  document.getElementById("exportTxtBtn").onclick=exportTxt;
  document.getElementById("backupAllBtn").onclick=backupAll;
  document.getElementById("restoreAllBtn").onclick=()=>document.getElementById("restoreFile").click();
  document.getElementById("restoreFile").onchange=async(e)=>{const f=e.target.files[0];if(f)await restoreAll(f);e.target.value=""};
  document.getElementById("micBtn").onclick=toggleVoice;

  document.getElementById("pickFolderBtn").onclick = pickFolder;
  document.getElementById("addTplBtn").onclick = addTpl;
  document.getElementById("resetTplBtn").onclick = resetTpl;
  document.getElementById("addPresetBtn").onclick = addPreset;
  document.getElementById("importPresetFolderBtn").onclick = importPresetFolder;
  document.getElementById("closeSettingsBtn").onclick = closeSettings;
  document.getElementById("saveSettingsBtn").onclick = saveSettings;
  document.getElementById("closePresetEditBtn").onclick = closePresetEdit;
  document.getElementById("savePresetEditBtn").onclick = savePresetEdit;
  document.getElementById("closeRegenModelModalBtn").onclick = closeRegenModelModal;
  
  document.getElementById("saveSkillDirBtn").onclick = async () => {
    const dir = document.getElementById("cfgSkillDir").value.trim();
    if (!dir) return alert("请输入目录路径");
    try {
      setStatus("正在更新 Skill 目录...");
      const res = await fetch(`${getRagUrl()}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_dir: dir })
      });
      const data = await res.json();
      if (data.status === "success") {
        alert("目录已更新！正在重新加载 Skill 列表...");
        const skillRes = await fetch(`${getRagUrl()}/api/skills`);
        const skillData = await skillRes.json();
        const skillSel = document.getElementById("skillSelect");
        if (skillData && skillData.skills) {
          skillSel.innerHTML = '<option value="">（未加载Skill）</option>' +
            skillData.skills.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
        }
        setStatus("Skill 目录已更新");
      }
    } catch (e) {
      alert("保存失败: " + e.message);
      setStatus("更新失败", true);
    }
  };

  document.getElementById("rebuildRagBtn").onclick = async () => {
    const btn = document.getElementById("rebuildRagBtn");
    const statusText = document.getElementById("ragBuildStatus");
    const progressWrap = document.getElementById("ragProgressBarWrap");
    const progressBar = document.getElementById("ragProgressBar");

    try {
      btn.disabled = true;
      btn.textContent = "⏳ 构建中...";
      statusText.textContent = "正在启动任务...";
      progressWrap.style.display = "block";
      progressBar.style.width = "0%";

      const res = await fetch(`${getRagUrl()}/api/build`, { method: "POST" });
      const data = await res.json();
      if (data.status === "running") {
        alert("已有构建任务在运行，请稍候");
        return;
      }

      const pollTimer = setInterval(async () => {
        try {
          const sres = await fetch(`${getRagUrl()}/api/build_status`);
          const sdata = await sres.json();
          
          if (sdata.status === "running") {
            const pct = sdata.total > 0 ? Math.round((sdata.progress / sdata.total) * 100) : 0;
            progressBar.style.width = pct + "%";
            statusText.textContent = sdata.message;
          } else if (sdata.status === "completed") {
            clearInterval(pollTimer);
            progressBar.style.width = "100%";
            statusText.textContent = sdata.message;
            btn.disabled = false;
            btn.textContent = "🔄 重建知识库";
            alert("🎉 知识库构建完成！");
          } else if (sdata.status === "failed") {
            clearInterval(pollTimer);
            statusText.textContent = sdata.message;
            btn.disabled = false;
            btn.textContent = "🔄 重建知识库";
            alert("❌ 构建失败：" + sdata.message);
          }
        } catch (e) { console.error(e); }
      }, 1500);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "🔄 重建知识库";
      alert("请求失败：" + e.message);
    }
  };

  document.getElementById("compressBtn").onclick=compressContext;
  document.getElementById("compareBtn").onclick=()=>{setCompareMode(!cfg.compareMode)};
  document.getElementById("ragBtn").onclick=()=>{cfg.ragEnabled=!cfg.ragEnabled;saveLocal();updateRagBadge();if(cfg.ragEnabled) setStatus("知识库已开启");else setStatus("知识库已关闭");};

  document.querySelectorAll("#accentPicker .color-swatch").forEach(s=>{s.onclick=()=>{document.getElementById("cfgAccent").value=s.dataset.color;document.querySelectorAll("#accentPicker .color-swatch").forEach(x=>x.classList.remove("active"));s.classList.add("active");};});
  document.getElementById("cfgAccent").oninput=(e)=>{document.querySelectorAll("#accentPicker .color-swatch").forEach(x=>x.classList.toggle("active",(x.dataset.color||"").toLowerCase()===e.target.value.toLowerCase()));};

  const input=document.getElementById("input");
  input.addEventListener("input",()=>{autoResize(input);saveDraft()});
  input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!generating)sendMessage()}});
  document.getElementById("sendBtn").onclick=()=>{if(generating){if(abortCtrl)abortCtrl.abort()}else sendMessage()};

  window.addEventListener("beforeunload",()=>{saveDraft();try{saveLocal()}catch(e){}});
  await fetchModels();
  updateCtxInfo();
  setInterval(()=>{if(!generating&&document.visibilityState==="visible")fetchModels()},30000);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&!generating)fetchModels();});
}
init();