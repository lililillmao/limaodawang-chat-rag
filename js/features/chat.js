// ============ 对话核心逻辑 ============

function buildMessages(isContinue = false, excludeGroupId = null, ragContext = null) {
  const s = getCurrentSession(); if (!s) return [];
  const list = [];
  const sys = getActiveSystemPrompt();
  if (sys) list.push({ role: "system", content: sys });
  if (ragContext && ragContext.trim()) {
    list.push({ role: "system", content: "【以下是从知识库、临时文件和长期记忆中检索到的参考资料，请严格基于这些资料回答用户的问题，不要凭空捏造】\n\n" + ragContext });
  }
  const hist = s.messages.slice(-cfg.contextRounds);
  for (const m of hist) {
    if (m.isSummary) { list.push({ role: "system", content: "【以下是之前对话的摘要，用于延续上下文，不要直接回复它】\n" + m.content }); continue; }
    if (m.compare) {
      if (excludeGroupId && m.groupId === excludeGroupId) continue;
      const parts = m.compare.map(c => `【${c.model || "模型"}】\n${c.content || ""}`).join("\n\n---\n\n");
      if (parts) list.push({ role: "assistant", content: parts });
      continue;
    }
    if (excludeGroupId && m.groupId === excludeGroupId) continue;
    if (m.role === "user" || m.role === "assistant") list.push({ role: m.role, content: m.content });
  }
  if (isContinue) list.push({ role: "user", content: "请从上面回答中断的地方**直接接着写**，不要重复已经说过的内容，不要道歉，不要重新开头。" });
  return list;
}

function getActiveSystemPrompt() {
  if (window.currentSkillPrompt && window.currentSkillPrompt.trim()) {
    return window.currentSkillPrompt;
  }
  const parts = [];
  let main = "";
  if (currentPresetId) {
    const p = presets.find(x => x.id === currentPresetId);
    if (p) main = p.prompt || "";
  } else {
    main = cfg.system || "";
  }
  if (main) parts.push(main);
  return parts.join("\n\n---\n\n");
}

// ★ 修复：末尾传入 aiMsg.providerId，让跨平台对比走各自的平台
async function runStream(aiMsg, isContinue = false, targetModel = null, groupId = null, groupIdToExclude = null, ragContext = null) {
  const s = getCurrentSession();
  const model = targetModel || cfg.model;
  const msgs = buildMessages(isContinue, groupIdToExclude, ragContext);
  abortCtrl = abortCtrl || new AbortController();
  const startTime = Date.now();
  setStatus(isContinue ? "继续生成中…" : "生成中…");

  await streamRequest(model, msgs,
    (msg) => {
      if (msg.thinking) aiMsg.thinking += msg.thinking;
      if (msg.content) aiMsg.content += msg.content;
      if (msg.usage) {
        aiMsg.promptTokens = msg.usage.prompt_tokens || msg.usage.promptTokens;
        aiMsg.completionTokens = msg.usage.completion_tokens || msg.usage.completionTokens;
      }
      streamUpdate();
    },
    () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const total = estimateTokens(aiMsg.content + (aiMsg.thinking || ""));
      aiMsg.speed = elapsed > 0.5 ? (total / elapsed) : 0;
      aiMsg.genTime = elapsed;
      s.updatedAt = Date.now(); saveLocal(); saveToDisk();
    },
    (e, aborted) => { if (aborted) setStatus("已停止"); else { aiMsg.content += `\n\n> ⚠️ 出错：${e.message}`; setStatus("出错", true); } },
    abortCtrl.signal,
    aiMsg.providerId || null
  );
}

// ★ 新增：后台静默提取记忆
async function extractMemoryFromConversation() {
  if (!cfg.memoryEnabled || !cfg.memoryExtract) return;
  const s = getCurrentSession();
  if (!s || s.messages.length < 2) return;

  const recent = s.messages.slice(-4)
    .filter(m => !m.isSummary && !m.compare && (m.role === "user" || m.role === "assistant"))
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
    .join('\n');

  if (!recent.trim()) return;

  const prompt = `请从以下对话中提取关于用户的、值得长期记住的个人信息、偏好或事实（例如姓名、喜好、习惯、重要的个人背景）。要求：
1. 只提取用户明确说出的内容，不要脑补。
2. 每条记忆尽量简短（不超过30字）。
3. 如果没有值得提取的内容，直接回复“无”。
4. 如果有，每行一条，不要添加序号或多余的解释。

对话如下：
${recent}`;

  try {
    let result = "";
    await streamRequest(cfg.model, [
      { role: "system", content: "你是一个信息提取助手，只输出提取到的内容。" },
      { role: "user", content: prompt }
    ],
      (msg) => { if (msg.content) result += msg.content; },
      async () => {
        result = result.trim();
        if (result && result !== "无" && result !== "无。") {
          const lines = result.split('\n').map(l => l.replace(/^[-\d\s.、*]+/, '').trim()).filter(l => l.length > 0);
          let added = false;
          for (const line of lines) {
            if (!memories.some(m => m.content === line)) {
              await addMemory(line, "自动提取");
              added = true;
            }
          }
          if (added) {
            await fetchMemories();
            if (document.getElementById("settingsMask").classList.contains("show")) {
              renderMemoryList();
            }
          }
        }
      },
      (e, aborted) => {},
      null,
      cfg.modelProviderId || null
    );
  } catch (e) {
    console.error("自动提取记忆失败:", e);
  }
}

function setCompareMode(on) {
  cfg.compareMode = !!on;
  const btn = document.getElementById("compareBtn");
  const sel2 = document.getElementById("modelSelect2");
  if (btn) btn.classList.toggle("on", cfg.compareMode);
  if (sel2) sel2.style.display = cfg.compareMode ? "inline-block" : "none";
  saveLocal();
}

async function sendMessage() {
  const input = document.getElementById("input");
  let text = input.value.trim();
  if (!text || generating) return;
  if (quoteState) { const quoted = quoteState.text.split("\n").map(l => "> " + l).join("\n"); text = `${quoted}\n\n${text}`; clearQuote(); }

  let ragContext = null;
  let ragSources = null;

  if (cfg.ragEnabled) {
    const ragRes = await fetchRagContext(text);
    if (ragRes) { ragContext = ragRes.context; ragSources = ragRes.sources; }
  }

  if (tempRagFiles.length > 0) {
    setStatus("正在读取临时文件内容...");
    let tempContext = "";
    const tempSources = [];

    for (const file of tempRagFiles) {
      let fileText = "";
      if (file.chunks && file.chunks.length > 0) {
        fileText = file.chunks.map(c => c.text).join("\n");
      }
      if (fileText.length > 3000) fileText = fileText.slice(0, 3000) + "...(截断)";

      if (fileText) {
        tempContext += `\n\n【临时文件：${file.filename}】\n${fileText}`;
        tempSources.push({
          name: `临时: ${file.filename}`,
          content: fileText,
          fullPath: "",
          distance: 0,
          skillId: "",
          isSafety: false
        });
      }
    }

    if (tempContext.trim()) {
      ragContext = (ragContext ? ragContext + "\n\n---\n\n" : "") + tempContext;
      ragSources = (ragSources || []).concat(tempSources);
    }
    setStatus("生成中…");
  }

  if (cfg.memoryEnabled) {
    const memRes = await searchMemories(text, cfg.memoryRounds || 3);
    if (memRes && memRes.length > 0) {
      const memContext = memRes.map(m => `[记忆] ${m.content}`).join("\n");
      ragContext = (ragContext ? ragContext + "\n\n---\n\n" : "") + "【以下是关于用户的长期记忆，请在回答时自然地运用】\n" + memContext;

      const memSources = memRes.map(m => ({
        name: `🧠 记忆`,
        content: m.content,
        fullPath: "",
        distance: m.distance,
        skillId: "",
        isSafety: false
      }));
      ragSources = (ragSources || []).concat(memSources);
    }
  }

  const s = getCurrentSession() || createSession();
  s.messages.push({ role: "user", content: text, time: Date.now() });
  if (s.title === "新对话") s.title = text.slice(0, 20);
  s.updatedAt = Date.now();
  input.value = ""; autoResize(input);
  saveDraft();
  renderSessions(); saveLocal(); saveToDisk();
  generating = true; updateSendBtn();
  abortCtrl = new AbortController();
  userWantsAutoScroll = true; updateJumpBtn();

  try {
    if (cfg.compareMode && cfg.model2 && cfg.model2 !== cfg.model) {
      const gid = "g" + Date.now();
      const msgA = { role: "assistant", content: "", thinking: "", model: cfg.model, groupId: gid, groupIdx: 0, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
      const msgB = { role: "assistant", content: "", thinking: "", model: cfg.model2, groupId: gid, groupIdx: 1, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId2 };
      s.messages.push(msgA, msgB);
      renderMessages();

      if (cfg.compareConcurrent) {
        await Promise.all([
          runStream(msgA, false, cfg.model, gid, null, ragContext),
          runStream(msgB, false, cfg.model2, gid, gid, ragContext)
        ]);
      } else {
        await runStream(msgA, false, cfg.model, gid, null, ragContext);
        await runStream(msgB, false, cfg.model2, gid, gid, ragContext);
      }

      const lastTwo = s.messages.slice(-2);
      if (lastTwo.length === 2 && lastTwo[0].groupId === gid && lastTwo[1].groupId === gid) {
        s.messages = s.messages.slice(0, -2);
        s.messages.push({ role: "assistant", groupId: gid, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, compare: [{ model: cfg.model, content: msgA.content, thinking: msgA.thinking, usage: { promptTokens: msgA.promptTokens, completionTokens: msgA.completionTokens } }, { model: cfg.model2, content: msgB.content, thinking: msgB.thinking, usage: { promptTokens: msgB.promptTokens, completionTokens: msgB.completionTokens } }] });
      }
    } else {
      const aiMsg = { role: "assistant", content: "", thinking: "", model: cfg.model, time: Date.now(), ragSources: ragSources, skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
      s.messages.push(aiMsg); renderMessages();
      await runStream(aiMsg, false, null, null, null, ragContext);
    }
    setStatus("完成");
  } finally {
    generating = false; abortCtrl = null; updateSendBtn();
    renderMessages(); saveLocal(); saveToDisk(); updateCtxInfo();
    extractMemoryFromConversation();
  }
}

async function continueGeneration() { if (generating) return; const s = getCurrentSession(); if (!s || !s.messages.length) return; const lastMsg = s.messages[s.messages.length - 1]; if (!lastMsg || lastMsg.role !== "assistant") return; if (lastMsg.compare) { alert("对比模式的消息暂不支持续写"); return; } if (!lastMsg.content && !lastMsg.thinking) return; generating = true; updateSendBtn(); abortCtrl = new AbortController(); await runStream(lastMsg, true); generating = false; abortCtrl = null; updateSendBtn(); renderMessages(); saveLocal(); saveToDisk(); updateCtxInfo(); extractMemoryFromConversation(); }

async function regenerateLast() {
  if (generating) return;
  const s = getCurrentSession(); if (!s || s.messages.length < 2) return;
  const lastMsg = s.messages[s.messages.length - 1];
  if (lastMsg.role !== "assistant") return;
  if (lastMsg.compare) { alert("对比模式暂不支持重新生成"); return; }
  const currentModel = lastMsg.model || cfg.model;
  const sel = document.getElementById("regenModelSelect");
  document.getElementById("regenCurrentModel").textContent = currentModel;
  let opts = allModelsCache.map(m => `<option value="${m.providerId}|${m.modelName}" ${m.modelName === currentModel ? "selected" : ""}>[${m.providerName}] ${m.modelName}</option>`).join("");
  sel.innerHTML = opts;
  document.getElementById("regenModelMask").classList.add("show");
  document.getElementById("regenConfirmBtn").onclick = async () => {
    const val = sel.value;
    if (!val) return;
    const [pid, useModel] = val.split("|");
    closeRegenModelModal();
    if (!lastMsg.versions) { lastMsg.versions = [{ model: lastMsg.model, content: lastMsg.content, thinking: lastMsg.thinking || "", time: lastMsg.time, speed: lastMsg.speed }]; lastMsg.currentVersion = 0; }
    lastMsg.model = useModel; lastMsg.content = ""; lastMsg.thinking = ""; lastMsg.time = Date.now(); lastMsg.speed = 0; lastMsg.providerId = pid;
    cfg.modelProviderId = pid;
    generating = true; updateSendBtn(); abortCtrl = new AbortController();
    renderMessages();
    try {
      await runStream(lastMsg, false, useModel);
      lastMsg.versions.push({ model: lastMsg.model, content: lastMsg.content, thinking: lastMsg.thinking || "", time: lastMsg.time, speed: lastMsg.speed });
      lastMsg.currentVersion = lastMsg.versions.length - 1;
    } finally {
      generating = false; abortCtrl = null; updateSendBtn(); renderMessages(); saveLocal(); saveToDisk(); updateCtxInfo();
    }
  };
}
function closeRegenModelModal() { document.getElementById("regenModelMask").classList.remove("show"); }

function startEditMessage(idx) { if (generating) { alert("生成中，请先停止"); return; } const s = getCurrentSession(); if (!s) return; const m = s.messages[idx]; if (!m || m.role !== "user") return; editingMsgIndex = idx; renderMessages(); }
function cancelEdit() { editingMsgIndex = -1; renderMessages(); }
async function saveEditMessage(idx) {
  const s = getCurrentSession(); if (!s) return;
  const ta = document.querySelector(`.msg-wrap[data-idx="${idx}"] .edit-area`); if (!ta) return;
  const newText = ta.value.trim(); if (!newText) { alert("不能为空"); return; }
  s.messages = s.messages.slice(0, idx); s.messages.push({ role: "user", content: newText, time: Date.now() });
  if (s.title === "新对话" || s.messages.length <= 2) s.title = newText.slice(0, 20);
  s.updatedAt = Date.now(); editingMsgIndex = -1; saveLocal(); saveToDisk(); renderSessions();
  let ragContext = null;
  if (cfg.ragEnabled) { ragContext = await fetchRagContext(newText); }
  generating = true; updateSendBtn(); abortCtrl = new AbortController();
  try {
    const aiMsg = { role: "assistant", content: "", thinking: "", model: cfg.model, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
    s.messages.push(aiMsg); renderMessages();
    await runStream(aiMsg, false, null, null, null, ragContext);
  } finally {
    generating = false; abortCtrl = null; updateSendBtn(); renderMessages(); saveLocal(); saveToDisk(); updateCtxInfo();
    extractMemoryFromConversation();
  }
}

function branchFromMessage(idx) {
  if (generating) { alert("生成中，请先停止"); return; }
  const s = getCurrentSession(); if (!s) return;
  const newS = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 7),
    title: (s.title || "对话") + " · 分支",
    messages: JSON.parse(JSON.stringify(s.messages.slice(0, idx + 1))),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    parentSessionId: s.id,
    branchPointIdx: idx
  };
  sessions.unshift(newS);
  currentSessionId = newS.id;
  userWantsAutoScroll = true;
  updateJumpBtn();
  saveLocal();
  saveToDisk();
  renderSessions();
  renderMessages();
  restoreDraft();
  setStatus("已创建分支");
  if (typeof updateBreadcrumb === "function") updateBreadcrumb();
  if (typeof updateParamBtnLabel === "function") updateParamBtnLabel();
}