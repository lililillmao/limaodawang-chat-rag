// ============ 输入区 + 快捷模板 + 语音 + 快捷键 ============

function updateSendBtn() { const b = document.getElementById("sendBtn"); if (generating) { b.textContent = "■ 停止"; b.classList.add("stop"); } else { b.textContent = "发送"; b.classList.remove("stop"); } }
function autoResize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; }

// ============ ★ 临时 RAG 文件处理 ============

function renderTempFileChips() {
  const box = document.getElementById("tempFileChips");
  if (!box) return;
  if (!tempRagFiles.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = tempRagFiles.map((f, i) => `
    <div class="temp-file-chip">
      <span class="chip-icon">📄</span>
      <span>${escapeHtml(f.filename)}</span>
      <span class="chip-del" data-idx="${i}" title="移除该临时文件">×</span>
    </div>
  `).join("");
  box.querySelectorAll(".chip-del").forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      tempRagFiles.splice(idx, 1);
      renderTempFileChips();
      setStatus(`已移除临时文件，剩余 ${tempRagFiles.length} 个`);
    };
  });
}

async function handleFiles(files) {
  if (!files || !files.length) return;
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) {
      alert(`文件 ${file.name} 过大，请上传小于 5MB 的文件。`);
      continue;
    }
    setStatus(`正在解析临时文件：${file.name}...`);

    // ★ 核心修改：纯文本文件直接由前端读取，不经过后端！
    if (file.name.match(/\.(md|txt|py|json|csv|html|css|js|xml|yaml|yml)$/i)) {
      try {
        const text = await file.text();
        if (!text.trim()) { setStatus(`${file.name} 内容为空`, true); continue; }
        
        // 前端做简易切片
        const chunks = [];
        let start = 0;
        while (start < text.length) {
          chunks.push({ text: text.slice(start, start + 600), embedding: [] });
          start += 500;
        }
        const existingIdx = tempRagFiles.findIndex(f => f.filename === file.name);
        if (existingIdx >= 0) tempRagFiles.splice(existingIdx, 1);
        
        tempRagFiles.push({ filename: file.name, chunks });
        setStatus(`已加载临时文件：${file.name}（${chunks.length} 个片段）`);
      } catch (e) {
        setStatus(`读取 ${file.name} 失败`, true);
      }
    } else {
      // 非文本文件（如 PDF、Word），仍走后端解析
      const data = await parseTempFile(file);
      if (data && data.chunks && data.chunks.length > 0) {
        const existingIdx = tempRagFiles.findIndex(f => f.filename === data.filename);
        if (existingIdx >= 0) tempRagFiles.splice(existingIdx, 1);
        tempRagFiles.push(data);
        setStatus(`已加载临时文件：${file.name}（${data.chunks.length} 个片段）`);
      } else {
        setStatus(`暂不支持该格式或文件无有效内容`, true);
      }
    }
  }
  renderTempFileChips();
}

function bindDragAndDrop() {
  const overlay = document.getElementById("globalDropOverlay");
  const inputInner = document.getElementById("inputInner");
  const fileInput = document.getElementById("fileInput");
  const fileUploadBtn = document.getElementById("fileUploadBtn");

  // ★ 全局拖拽拦截
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      if (overlay) overlay.classList.add("show");
    }
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null || e.relatedTarget === undefined) {
      if (overlay) overlay.classList.remove("show");
    }
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (overlay) overlay.classList.remove("show");
    handleFiles(e.dataTransfer.files);
  });

  // ★ 点击回形针上传
  if (fileUploadBtn && fileInput) {
    fileUploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      handleFiles(e.target.files);
      e.target.value = ""; 
    };
  }

  if (inputInner) {
    inputInner.addEventListener("dragover", (e) => { e.preventDefault(); inputInner.classList.add("dragover"); });
    inputInner.addEventListener("dragleave", () => inputInner.classList.remove("dragover"));
    inputInner.addEventListener("drop", () => inputInner.classList.remove("dragover"));
  }
}

// ============ 快捷模板 ============
function renderQuickPrompts() {
  const box = document.getElementById("quickPrompts"); if (!box) return;
  if (!cfg.quickPrompts || !cfg.quickPrompts.length) { box.innerHTML = ""; return; }
  box.innerHTML = cfg.quickPrompts.map((p, i) => `<button class="quick-btn" data-idx="${i}">${escapeHtml(p)}</button>`).join("");
  box.querySelectorAll(".quick-btn").forEach(btn => {
    btn.onmousedown = () => {
      const sel = window.getSelection();
      const t = sel ? sel.toString() : "";
      if (t) cachedSelection = t;
    };
    btn.onclick = async () => {
      const input = document.getElementById("input");
      const idx = parseInt(btn.dataset.idx);
      const raw = cfg.quickPrompts[idx] || btn.textContent || "";
      const prompt = await resolveTemplateVars(raw);
      if (raw === "翻译") input.value = input.value ? `请将以下内容翻译成中文：\n\n${input.value}` : "请将以下内容翻译成中文：\n\n";
      else if (raw === "总结") input.value = input.value ? `请总结以下内容：\n\n${input.value}` : "请总结以下内容：\n\n";
      else if (raw === "改代码") input.value = input.value ? `请优化以下代码：\n\n${input.value}` : "请优化以下代码：\n\n";
      else input.value = input.value ? `${prompt}\n\n${input.value}` : prompt + "\n\n";
      autoResize(input); saveDraft(); input.focus();
    };
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (generating) { alert("生成中"); return; } createSession(); renderMessages(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); const inp = document.getElementById("input"); inp.value = ""; autoResize(inp); saveDraft(); inp.focus(); return; }
    if (e.ctrlKey && e.key === ",") { e.preventDefault(); openSettings(); return; }
    if (e.key === "Escape") {
      if (document.getElementById("regenModelMask").classList.contains("show")) { closeRegenModelModal(); return; }
      if (quoteState) { clearQuote(); return; }
      if (editingMsgIndex >= 0) { cancelEdit(); return; }
      if (generating && abortCtrl) abortCtrl.abort();
    }
  });
}

function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("你的浏览器不支持语音识别。请用 Chrome 或 Edge 打开。"); return; }
  const btn = document.getElementById("micBtn");
  if (voiceRec) { try { voiceRec.stop(); } catch (e) { } voiceRec = null; btn.classList.remove("recording"); return; }
  voiceRec = new SR(); voiceRec.lang = "zh-CN"; voiceRec.continuous = true; voiceRec.interimResults = true;
  const input = document.getElementById("input"); let baseText = input.value;
  voiceRec.onresult = (e) => { let final = "", interim = ""; for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) final += e.results[i][0].transcript; else interim += e.results[i][0].transcript; } if (final) baseText += final; input.value = baseText + interim; autoResize(input); saveDraft(); };
  voiceRec.onerror = (e) => { if (e.error === "not-allowed") alert("麦克风权限被拒绝。请在浏览器地址栏左侧点🔒图标允许麦克风访问。"); voiceRec = null; btn.classList.remove("recording"); };
  voiceRec.onend = () => { voiceRec = null; btn.classList.remove("recording"); };
  try { voiceRec.start(); btn.classList.add("recording"); } catch (e) { alert("启动失败：" + e.message); voiceRec = null; }
}

function updateRagBadge() {
  const badge = document.getElementById("ragBadge"); const btn = document.getElementById("ragBtn"); if (!badge || !btn) return;
  if (cfg.ragEnabled) { badge.textContent = "开"; btn.classList.add("on"); } else { badge.textContent = "关"; btn.classList.remove("on"); }
}