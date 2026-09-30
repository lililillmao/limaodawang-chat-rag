// ============ 输入区 + 快捷模板 + 语音 + 快捷键 ============

// ============ ★ 1.23：临时图片处理（多模态输入） ============

// 单张图片的存储上限（dataURL 长度）。localStorage 总配额约 5MB，所以必须压得比较狠。
const IMG_MAX_STORE_BYTES = 400 * 1024;
const IMG_MAX_COUNT = 6;

// ★ 1.23.3：视觉模型能力检测
// 用关键词匹配，覆盖常见的本地 / 云端视觉模型。宁可宽松也不漏判。
const VISION_MODEL_RE = /vision|llava|minicpm-v|moondream|bakllava|[-_/]vl(?![a-z])|vl-|gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-4\.1|gemini|claude-3|claude-sonnet-4|claude-opus|glm-4v/i;

function isVisionCapable(modelName) {
  if (!modelName) return false;
  return VISION_MODEL_RE.test(String(modelName));
}

// 判断当前选中的模型是否支持视觉。返回：
//   { ok: true } 或 { ok: false, model, provider }
function checkCurrentModelVision() {
  const providerId = cfg.modelProviderId || currentProviderId;
  const provider = (cfg.providers || []).find(p => p.id === providerId) || null;
  const model = cfg.model || "";
  if (isVisionCapable(model)) return { ok: true, model, provider };
  return { ok: false, model, provider };
}

// 把 File 读成 dataURL
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
}

// 压缩图片：按最长边缩放到 cfg.imageMaxEdge，并逐步降低 JPEG 质量直到小于目标体积。
// GIF 不动（动图重编码会丢帧），直接原样保留。
async function compressImage(file) {
  const rawDataUrl = await readFileAsDataUrl(file);
  if (file.type === "image/gif") {
    return { dataUrl: rawDataUrl, b64: rawDataUrl.split(",")[1] || "", mime: "image/gif", note: "" };
  }

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("图片解码失败"));
    i.src = rawDataUrl;
  });

  const maxEdge = parseInt(cfg.imageMaxEdge, 10) || 1568;
  let { width: w, height: h } = img;
  const long = Math.max(w, h);
  if (long > maxEdge) {
    const k = maxEdge / long;
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  // 白色打底：PNG 透明区域转 JPEG 后会变黑，铺白更自然
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // 从 0.85 开始逐档降质量，直到体积达标
  // ★ 修复（10）：原来先无条件 canvas.toDataURL("image/jpeg", 0.85) 做一次，
  //   紧接着进循环又从 0.85 重做一遍，等于每张图多了一次完整的 JPEG 编码
  //   （大图上是肉眼可见的卡顿）。现在只在循环里编码一次，达标即跳出。
  const qualities = [0.85, 0.75, 0.65, 0.55, 0.45];
  let out = "";
  for (const q of qualities) {
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length <= IMG_MAX_STORE_BYTES) break;
  }
  const note = (out.length > IMG_MAX_STORE_BYTES) ? "（已压缩到上限，仍偏大）" : "";

  return {
    dataUrl: out,
    b64: out.split(",")[1] || "",
    mime: "image/jpeg",
    note,
    w, h
  };
}

// 处理拖入 / 选中的图片文件
async function handleImages(files) {
  const list = Array.from(files || []).filter(f => f.type && f.type.startsWith("image/"));
  if (!list.length) return;

  // ★ 1.23.3：先检查视觉功能开关
  if (cfg.visionEnabled === false) {
    setStatus("图片输入已在设置中关闭", true);
    return;
  }

  // ★ 1.23.3：再检查当前模型是否支持视觉
  const visionCheck = checkCurrentModelVision();
  if (!visionCheck.ok) {
    const modelName = visionCheck.model || "(未选择模型)";
    const msg = `⚠️ 当前模型 ${modelName} 不支持图片输入。\n\n请先在顶栏模型下拉框切换到视觉模型，例如：\n  • 本地：qwen2-vl / llava / llama3.2-vision / minicpm-v\n  • 云端：gpt-4o / qwen-vl-max / glm-4v / claude-3\n\n（如果模型已拉取但仍提示，请在切换模型后再拖入图片）`;
    alert(msg);
    setStatus(`当前模型不支持图片，已忽略 ${list.length} 张`, true);
    return;
  }

  for (const file of list) {
    if (file.size > 12 * 1024 * 1024) {
      alert(`图片 ${file.name} 超过 12MB，请先压缩或换一张。`);
      continue;
    }
    if (tempImages.length >= IMG_MAX_COUNT) {
      alert(`一次最多附带 ${IMG_MAX_COUNT} 张图片，已忽略：${file.name}`);
      continue;
    }
    setStatus(`正在压缩图片：${file.name}…`);
    try {
      const out = await compressImage(file);
      // 同名去重（与临时文件一致的"先删后加 = 替换"语义）
      const existingIdx = tempImages.findIndex(im => im.name === file.name);
      if (existingIdx >= 0) tempImages.splice(existingIdx, 1);
      tempImages.push({
        name: file.name,
        mime: out.mime,
        dataUrl: out.dataUrl,
        b64: out.b64,
        size: out.dataUrl.length
      });
      const kb = Math.round(out.dataUrl.length / 1024);
      setStatus(`已添加图片：${file.name}（约 ${kb}KB${out.note}）`);
    } catch (e) {
      setStatus(`图片 ${file.name} 处理失败：${e.message}`, true);
    }
  }
  renderTempFileChips();
}

// 图片缩略图 chip 的 HTML（与临时文件 chip 混排在同一容器里）
function buildImageChipsHtml() {
  if (!tempImages.length) return "";
  return tempImages.map((im, i) => `
    <div class="temp-file-chip temp-image-chip" title="${escapeHtml(im.name)}">
      <img class="chip-thumb" src="${im.dataUrl}" alt="${escapeHtml(im.name)}">
      <span class="chip-name">${escapeHtml(im.name)}</span>
      <span class="chip-del" data-img-idx="${i}" title="移除这张图片">×</span>
    </div>
  `).join("");
}

function updateSendBtn() { const b = document.getElementById("sendBtn"); if (generating) { b.textContent = "■ 停止"; b.classList.add("stop"); } else { b.textContent = "发送"; b.classList.remove("stop"); } }
function autoResize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; }

// ============ ★ 临时 RAG 文件处理 ============

function renderTempFileChips() {
  const box = document.getElementById("tempFileChips");
  if (!box) return;
  if (!tempRagFiles.length && !tempImages.length) {
    box.innerHTML = "";
    return;
  }
  // ★ 1.23：图片 chip 与文件 chip 混排，图片在前（视觉上更贴近输入）
  const imgHtml = typeof buildImageChipsHtml === "function" ? buildImageChipsHtml() : "";
  const fileHtml = tempRagFiles.map((f, i) => `
    <div class="temp-file-chip">
      <span class="chip-icon">📄</span>
      <span>${escapeHtml(f.filename)}</span>
      <span class="chip-del" data-idx="${i}" title="移除该临时文件">×</span>
    </div>
  `).join("");
  box.innerHTML = imgHtml + fileHtml;

  box.querySelectorAll(".chip-del[data-idx]").forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      tempRagFiles.splice(idx, 1);
      renderTempFileChips();
      setStatus(`已移除临时文件，剩余 ${tempRagFiles.length} 个`);
    };
  });
  // ★ 1.23：图片删除
  box.querySelectorAll(".chip-del[data-img-idx]").forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.imgIdx);
      tempImages.splice(idx, 1);
      renderTempFileChips();
      setStatus(`已移除图片，剩余 ${tempImages.length} 张`);
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
    // ★ 1.23：图片与文档分流。图片走多模态通道，文档走临时知识库通道。
    const all = Array.from(e.dataTransfer.files || []);
    const imgs = all.filter(f => f.type && f.type.startsWith("image/"));
    const docs = all.filter(f => !(f.type && f.type.startsWith("image/")));
    if (imgs.length) handleImages(imgs);
    if (docs.length) handleFiles(docs);
  });

  // ★ 点击回形针上传
  if (fileUploadBtn && fileInput) {
    fileUploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      // ★ 1.23：同一个选择框里也可能混着图片
      const all = Array.from(e.target.files || []);
      const imgs = all.filter(f => f.type && f.type.startsWith("image/"));
      const docs = all.filter(f => !(f.type && f.type.startsWith("image/")));
      if (imgs.length) handleImages(imgs);
      if (docs.length) handleFiles(docs);
      e.target.value = "";
    };
  }

  // ★ 1.23：粘贴图片（截图后 Ctrl+V 直接进输入框）
  const ta = document.getElementById("input");
  if (ta) {
    ta.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const imgs = [];
      for (const it of items) {
        if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) imgs.push(f);
        }
      }
      if (imgs.length) { e.preventDefault(); handleImages(imgs); }
    });
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
      // ★ 1.23：优先关闭图片放大预览
      const iv = document.getElementById("imgViewerMask");
      if (iv && iv.classList.contains("show")) { iv.classList.remove("show"); return; }
      const tm = document.getElementById("toolsInfoMask");
      if (tm && tm.classList.contains("show")) { tm.classList.remove("show"); return; }
      const sm = document.getElementById("statsMask");
      if (sm && sm.classList.contains("show")) { closeStats(); return; }
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

// ★ 1.23：工具调用开关的徽章
function updateToolsBadge() {
  const badge = document.getElementById("toolsBadge");
  const btn = document.getElementById("toolsBtn");
  if (!badge || !btn) return;
  if (cfg.toolsEnabled) { badge.textContent = "开"; btn.classList.add("on"); }
  else { badge.textContent = "关"; btn.classList.remove("on"); }
}

// ★ 1.23：展示已注册工具清单的说明弹窗
function renderToolsInfo() {
  const box = document.getElementById("toolsInfoBody");
  if (!box) return;
  const list = (typeof TOOLS_REGISTRY !== "undefined" && Array.isArray(TOOLS_REGISTRY)) ? TOOLS_REGISTRY : [];
  const head = `<div style="font-size:12px;color:var(--text-dim);line-height:1.7;margin-bottom:10px">
    工具调用让模型能读取当前时间、做精确计算、检索你的知识库。开启后，模型会在需要时自动请求调用；
    所有工具都在浏览器本地执行，且<b>只读、无副作用</b>——不会写文件、不会执行命令。<br>
    当前状态：<b>${cfg.toolsEnabled ? "已开启" : "已关闭"}</b>　最大轮次：<b>${parseInt(cfg.maxToolRounds, 10) || 5}</b>
  </div>`;
  if (!list.length) {
    box.innerHTML = head + `<div style="color:var(--text-dim);font-size:13px">没有已注册的工具。</div>`;
    return;
  }
  const rows = list.map(t => `<div class="tools-info-row">
      <div class="tools-info-name">🔧 ${escapeHtml(t.name)}</div>
      <div class="tools-info-desc">${escapeHtml(t.description || "")}</div>
      <div class="tools-info-badge">${t.readOnly ? "只读" : "有副作用"}</div>
    </div>`).join("");
  const warn = `<div style="font-size:11px;color:#f0a020;margin-top:10px;line-height:1.6">
    ⚠️ 部分模型的 function calling 支持并不完善，开启后若出现报错或输出异常，关闭该开关即可恢复原有行为。
  </div>`;
  box.innerHTML = head + rows + warn;
}