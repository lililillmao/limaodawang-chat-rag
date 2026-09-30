// ============ 对话核心逻辑 ============

// ★ 1.23.2：检测模型把工具调用当文本输出的失败模式
//   qwen2.5:7b 在 Ollama 上有时会把 tool_call 内容直接输出到 content 里
//   （例如 `{"name": "get_current_time", "arguments": {}}`），
//   本函数从文本里提取这些"伪工具调用"，交给正常的多轮流程处理。
function extractTextToolCalls(text) {
  if (!text) return [];
  const results = [];
  // 兼容扁平 JSON：{"name": "xxx", "arguments": {...}}
  const re = /"name"\s*:\s*"([^"]+)"[^{}]*?"arguments"\s*:\s*(\{[^{}]*\}|\[[^\[\]]*\]|"[^"]*")/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    let argsStr = m[2];
    if (typeof getToolByName !== "function" || !getToolByName(name)) continue;
    if (argsStr.startsWith('"')) argsStr = "{}";
    results.push({
      id: "call_text_" + Date.now() + "_" + results.length,
      type: "function",
      function: { name, arguments: argsStr }
    });
  }
  return results;
}

// ★ 1.23.1：针对 Ollama 与 OpenAI 的工具消息格式差异做了分支处理
function buildMessages(isContinue = false, excludeGroupId = null, ragContext = null, opts = null) {
  const s = getCurrentSession(); if (!s) return [];
  const options = opts || {};
  const isOllama = options.providerType === "ollama";
  const list = [];
  const sys = getActiveSystemPrompt();
  if (sys) list.push({ role: "system", content: sys });
  if (ragContext && ragContext.trim()) {
    list.push({ role: "system", content: "【以下是从知识库、临时文件和长期记忆中检索到的参考资料，请严格基于这些资料回答用户的问题，不要凭空捏造】\n\n" + ragContext });
  }

  // 找出最后一条真实用户消息的下标
  let lastUserIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === "user" && !s.messages[i].isSummary) { lastUserIdx = i; break; }
  }

  const start = Math.max(0, s.messages.length - cfg.contextRounds);
  const hist = s.messages.slice(start);

  hist.forEach((m, k) => {
    const realIdx = start + k;
    if (m.isSummary) { list.push({ role: "system", content: "【以下是之前对话的摘要，用于延续上下文，不要直接回复它】\n" + m.content }); return; }
    if (m.compare) {
      if (excludeGroupId && m.groupId === excludeGroupId) return;
      // ★ 修复（5 的前置）：compare 数组可能不完整（例如对比生成中途被中断、
      //   或历史数据损坏），这里对每一项做保护，避免 map 里读 c.model 抛异常。
      const parts = m.compare
        .filter(c => c && (c.content || c.thinking))
        .map(c => `【${(c && c.model) || "模型"}】\n${(c && c.content) || ""}`)
        .join("\n\n---\n\n");
      if (parts) list.push({ role: "assistant", content: parts });
      return;
    }
    if (excludeGroupId && m.groupId === excludeGroupId) return;

    // ★ 工具结果消息（回灌给模型）
    if (m.role === "tool") {
      if (isOllama) {
        list.push({ role: "tool", content: m.content || "" });
      } else {
        list.push({ role: "tool", tool_call_id: m.toolCallId || "", content: m.content || "" });
      }
      return;
    }

    // ★ 带工具调用的 assistant 消息
    if (m.role === "assistant" && (m.content || (m.toolCalls && m.toolCalls.length))) {
      const item = { role: "assistant", content: m.content || "" };
      if (m.toolCalls && m.toolCalls.length) {
        if (isOllama) {
          // ★ Ollama 的 tool_calls 与 OpenAI 不同：
          //   - arguments 必须是「对象」，不能是 JSON 字符串
          //   - 不需要 id / type 字段
          item.tool_calls = m.toolCalls.map(tc => {
            let argsObj = {};
            try { argsObj = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { argsObj = {}; }
            if (!argsObj || typeof argsObj !== "object" || Array.isArray(argsObj)) argsObj = {};
            return { function: { name: (tc.function && tc.function.name) || "", arguments: argsObj } };
          });
        } else {
          item.tool_calls = m.toolCalls;
        }
      }
      list.push(item);
      return;
    }

    if (m.role === "user") {
      if (options.images && options.images.length && realIdx === lastUserIdx) {
        list.push(buildMultimodalUserMessage(m.content, options.images, options.providerType));
      } else if (Array.isArray(m.images) && m.images.length) {
        list.push(buildMultimodalUserMessage(m.content, m.images, options.providerType));
      } else {
        list.push({ role: "user", content: m.content });
      }
      return;
    }

    // ★ 修复（4）：不能把空的 assistant 消息发给服务端。
    //   两种情况会产生空 assistant：
    //     1) 对比模式在 s.messages 里先压入两条占位的空 assistant（生成开始时），
    //        如果这一轮生成失败/被中断，它们会作为历史留在会话里；
    //     2) 任何中途中断留下的 content="" 且 thinking="" 的助手消息。
    //   OpenAI 兼容接口对 content 为空的 assistant 消息会直接返回 400
    //   （Ollama 相对宽容，但同样没有意义）。这里统一跳过。
    if (m.role === "assistant") {
      const text = (m.content || "").trim();
      if (!text && !(m.thinking || "").trim()) return; // 空消息，丢弃
      list.push({ role: "assistant", content: m.content });
    }
  });

  if (isContinue) list.push({ role: "user", content: "请从上面回答中断的地方**直接接着写**，不要重复已经说过的内容，不要道歉，不要重新开头。" });
  return list;
}

function getActiveSystemPrompt() {  if (window.currentSkillPrompt && window.currentSkillPrompt.trim()) {
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

// ★ 1.23：成本统计记账
function recordUsageForMessage(aiMsg) {
  if (!aiMsg || typeof recordUsage !== "function") return;
  const p = toTokenNum(aiMsg.promptTokens);
  const c = toTokenNum(aiMsg.completionTokens);
  if (!p && !c) return;
  const provider = cfg.providers.find(x => x.id === aiMsg.providerId) || getCurrentProvider() || {};
  try {
    recordUsage({
      providerId: provider.id || "unknown",
      providerName: provider.name || "未知平台",
      providerType: provider.type || "openai",
      model: aiMsg.model || cfg.model || "",
      promptTokens: p,
      completionTokens: c,
      sessionId: (getCurrentSession() || {}).id || "",
      kind: aiMsg.groupId ? "compare" : (aiMsg.toolCalls && aiMsg.toolCalls.length ? "tool" : "chat")
    });
  } catch (e) {
    console.warn("⚠️ 记账失败", e);
  }
}

// ★ 修复：末尾传入 aiMsg.providerId，让跨平台对比走各自的平台
async function runStream(aiMsg, isContinue = false, targetModel = null, groupId = null, groupIdToExclude = null, ragContext = null, opts = null) {
  const s = getCurrentSession();
  const model = targetModel || cfg.model;
  const options = opts || {};
  const providerType = (cfg.providers.find(p => p.id === aiMsg.providerId) || getCurrentProvider() || {}).type || "ollama";
  // ★ 修复（15）：原来这里传了 opts.withTools，但 buildMessages 从来不读它——
  //   是个死参数，容易让人以为"工具是通过 buildMessages 挂上去的"。
  //   实际上工具的声明是在下面的 reqOpts 里交给 streamRequest 的。
  //   这里移除，避免误导。
  const msgs = buildMessages(isContinue, groupIdToExclude, ragContext, {
    images: options.images || null,
    providerType
  });
  abortCtrl = abortCtrl || new AbortController();
  // ★ 修复：本轮的取消句柄必须在进入时就"锁定"下来。
  //   原来 runStream 的返回值用共享的全局 abortCtrl.signal.aborted 判断本轮是否被取消，
  //   而并发生成（对比模式 + compareConcurrent）下两个 runStream 共用同一个 AbortController：
  //   A 被取消后 abortCtrl.signal.aborted 变为 true，B 虽然从未被取消，
  //   runStreamWithTools 也会因为 res.aborted 直接 return，导致 B 什么都不生成。
  //   现在用局部引用判断"本轮"的中断状态，并把该句柄交给 streamRequest。
  const localCtrl = abortCtrl;
  const startTime = Date.now();
  const prevGenTime = aiMsg.genTime || 0;
  const prevSpeed = aiMsg.speed || 0;
  // ★ 修复：多轮工具调用时 usage 会被算错。
  //   Ollama / OpenAI 在流结束时给出的都是【本轮的绝对值】，而多轮工具调用会调用
  //   runStream 多次、每次的 prompt 都比上一轮更长（历史里多了工具结果）。
  //   原来用 Math.max() 会让 aiMsg.promptTokens 只等于"最后一轮的值"，
  //   既漏掉了前面各轮的消耗，也让成本统计偏小。
  //   正确做法：每轮算出增量，再累加到消息上。
  const prevPTokens = toTokenNum(aiMsg.promptTokens);
  const prevCTokens = toTokenNum(aiMsg.completionTokens);
  let roundPTokens = 0;
  let roundCTokens = 0;
  setStatus(isContinue ? "继续生成中…" : "生成中…");

  let triggeredTools = [];
  let lastFinishReason = "";
  let usageSource = "";

  const reqOpts = options.withTools
    ? { tools: getToolSchemas(), toolChoice: "auto" }
    : null;

  await streamRequest(model, msgs,
    (msg) => {
      if (msg.thinking) aiMsg.thinking = (aiMsg.thinking || "") + msg.thinking;
      if (msg.content) aiMsg.content = (aiMsg.content || "") + msg.content;

      if (msg.tool_calls) {
        aiMsg._toolAcc = accumulateToolCalls(aiMsg._toolAcc, msg.tool_calls);
      }
      if (msg.finish_reason) lastFinishReason = msg.finish_reason;

      if (msg.usage) {
        const p = toTokenNum(msg.usage.prompt_tokens != null ? msg.usage.prompt_tokens : msg.usage.promptTokens);
        const c = toTokenNum(msg.usage.completion_tokens != null ? msg.usage.completion_tokens : msg.usage.completionTokens);
        // 服务端在流末尾给的是本轮绝对值，同一轮内可能出现多次（取本轮最大值）
        if (p > roundPTokens) roundPTokens = p;
        if (c > roundCTokens) roundCTokens = c;
        // 立刻反映到消息上（含前面轮次的累计），让 UI 实时显示
        aiMsg.promptTokens = prevPTokens + roundPTokens;
        aiMsg.completionTokens = prevCTokens + roundCTokens;
        if (msg.usage.source) usageSource = msg.usage.source;
      }

      streamUpdate();
    },
    () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const total = estimateTokens(aiMsg.content + (aiMsg.thinking || ""));
      const roundSpeed = elapsed > 0.5 ? (total / elapsed) : 0;
      aiMsg.genTime = prevGenTime + elapsed;
      aiMsg.speed = roundSpeed > 0 ? ((prevSpeed > 0 && prevGenTime > 0) ? (prevSpeed + roundSpeed) / 2 : roundSpeed) : prevSpeed;

      const normalized = normalizeToolCalls(aiMsg._toolAcc);
      if (normalized.length) {
        aiMsg.toolCalls = (aiMsg.toolCalls || []).concat(normalized);
        triggeredTools = triggeredTools.concat(normalized);
        aiMsg._toolAcc = null;
      }
      if (lastFinishReason) aiMsg.finishReason = lastFinishReason;
      if (usageSource) aiMsg.usageSource = usageSource;

      s.updatedAt = Date.now();
      saveLocal();
      saveToDisk();
    },
    (e, aborted) => {
      // ★ 修复：只在本轮确实被取消时才提示"已停止"。
      //   并发生成时另一条流被取消也会让 e 变成 AbortError，原来会把两条都标成"已停止"。
      if (aborted) { if (localCtrl && localCtrl.signal.aborted) setStatus("已停止"); }
      else { aiMsg.content += `\n\n> ⚠️ 出错：${e.message}`; setStatus("出错", true); }
    },
    localCtrl.signal,
    aiMsg.providerId || null,
    reqOpts
  );

  // ★ 修复：用本轮锁定的 localCtrl 判断，而不是共享的 abortCtrl
  return { triggeredTools, aborted: !!(localCtrl && localCtrl.signal && localCtrl.signal.aborted) };
}

// ★ 1.23：带工具调用的多轮生成
// ★ 1.23.1：修复多轮工具调用时，中间过程的内容会被拼到最终回答里
// ★ 1.23.2：新增对"模型把工具调用当文本输出"的失败模式的处理
async function runStreamWithTools(aiMsg, isContinue = false, targetModel = null, ragContext = null, images = null) {
  const s = getCurrentSession();
  const maxRounds = Math.max(1, parseInt(cfg.maxToolRounds, 10) || 5);
  const useTools = !!cfg.toolsEnabled;

  for (let round = 1; round <= maxRounds; round++) {
    if (abortCtrl && abortCtrl.signal.aborted) return;

    if (useTools && maxRounds > 1) setToolRoundStatus(round, maxRounds);

    const contentBefore = aiMsg.content || "";
    const thinkingBefore = aiMsg.thinking || "";

    const res = await runStream(aiMsg, round === 1 ? isContinue : false, targetModel, null, null, ragContext, {
      withTools: useTools,
      images: round === 1 ? images : null
    });

    if (res.aborted) return;

    let calls = res.triggeredTools || [];
    let isTextCall = false;

    // ★ 1.23.2 新增：检测模型把工具调用当文本输出的失败模式
    if (useTools && !calls.length) {
      const textCalls = extractTextToolCalls(aiMsg.content);
      if (textCalls.length) {
        console.log("[工具调用] 检测到文本形式的工具调用:", textCalls.map(t => t.function.name).join(", "));
        calls = textCalls;
        isTextCall = true;
        aiMsg.content = "";
        aiMsg.thinking = "";
      }
    }

    if (!calls.length) {
      if (useTools) toolRoundCurrent = 0;
      return;
    }

    // 本轮触发了工具调用 → 把本轮产生的中间内容还原
    if (!isTextCall) {
      aiMsg.content = contentBefore;
      aiMsg.thinking = thinkingBefore;
    }

    if (round === maxRounds) {
      aiMsg.content += `\n\n> ⚠️ 工具调用已达上限（${maxRounds} 轮），自动停止。可在「⚙ 设置」中调大「最大工具轮次」。`;
      if (useTools) toolRoundCurrent = 0;
      return;
    }

    for (const call of calls) {
      if (abortCtrl && abortCtrl.signal.aborted) { if (useTools) toolRoundCurrent = 0; return; }

      const toolName = call.function && call.function.name;
      setStatus(`🔧 正在执行：${getToolDisplayName(toolName)}…`);
      s.updatedAt = Date.now();
      renderMessages();

      const result = await executeToolCall(call);
      const text = toolResultToText(result);

      aiMsg.toolResults = aiMsg.toolResults || [];
      aiMsg.toolResults.push({
        id: call.id,
        name: toolName,
        args: call.function ? call.function.arguments : "",
        ok: !!result.ok,
        ms: result.ms || 0,
        text
      });

      s.messages.push({
        role: "tool",
        content: text,
        toolCallId: call.id,
        toolName: toolName,
        time: Date.now(),
        hidden: true
      });
    }

    s.updatedAt = Date.now();
    saveLocal(); saveToDisk();
    renderMessages();
    setStatus("🔧 已获取工具结果，继续生成…");
  }

  if (useTools) toolRoundCurrent = 0;
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
  // ★ 修复（9）：纯图片消息发不出去。
  //   原来是 `if (!text || generating) return;`——用户只贴了图片、没打字时
  //   text 为空，函数直接 return，图片永远发不出去。
  //   现在只要"有文字或有图片"就放行。
  const pendingImages = (typeof tempImages !== "undefined" && Array.isArray(tempImages)) ? tempImages.length : 0;
  if ((!text && !pendingImages) || generating) return;
  if (quoteState) { const quoted = quoteState.text.split("\n").map(l => "> " + l).join("\n"); text = `${quoted}\n\n${text}`.trim(); clearQuote(); }
  // 纯图片也要有可显示的占位文本，否则侧栏标题与消息气泡都是空的。
  // 放在引用拼接之后计算，这样引用 + 纯图片时也能拿到正确的展示文本。
  const displayText = text || (pendingImages ? "（图片）" : "");
  // 真正发给模型/检索用的文本：纯图片时留空，避免把一个假文本塞进检索与上下文
  const queryText = text;

  let ragContext = null;
  let ragSources = null;

  if (cfg.ragEnabled && queryText) {
    const ragRes = await fetchRagContext(queryText);
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

  if (cfg.memoryEnabled && queryText) {
    const memRes = await searchMemories(queryText, cfg.memoryRounds || 3);
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

  // ★ 1.23：本轮附带的图片，存进消息以便刷新后仍能看到
  const sendImages = (typeof tempImages !== "undefined" && tempImages.length) ? tempImages.slice() : [];
  // ★ 修复（9）：纯图片时 content 用占位文本，保证气泡、侧栏标题、导出都不是空的
  const userMsg = { role: "user", content: displayText, time: Date.now() };
  if (sendImages.length) {
    userMsg.images = sendImages.map(im => ({ name: im.name, mime: im.mime, dataUrl: im.dataUrl }));
  }
  s.messages.push(userMsg);

  if (s.title === "新对话") s.title = (text || displayText).slice(0, 20) || "新对话";
  s.updatedAt = Date.now();
  input.value = ""; autoResize(input);
  saveDraft();
  // ★ 修复（8）+（9）：临时附件在"发送成功"后才清空。
  //   （8）原来 tempRagFiles 永远不清空——临时文件会被反复注入到之后每一条消息的
  //       system prompt 里，越积越大，直到刷新页面为止。UI 上的 chip 也一直挂着。
  //   （9）图片清空逻辑与此合并，统一在消息真正入队后执行。
  if (sendImages.length || tempRagFiles.length) {
    tempImages = [];
    tempRagFiles = [];
    renderTempFileChips();
  }
  renderSessions(); saveLocal(); saveToDisk();
  generating = true; updateSendBtn();
  abortCtrl = new AbortController();
  userWantsAutoScroll = true; updateJumpBtn();

  const modelImages = sendImages.map(im => ({
    mime: im.mime,
    dataUrl: im.dataUrl,
    b64: String(im.dataUrl || "").split(",")[1] || ""
  })).filter(im => im.b64);

  try {
    if (cfg.compareMode && cfg.model2 && cfg.model2 !== cfg.model) {
      const gid = "g" + Date.now();
      const msgA = { role: "assistant", content: "", thinking: "", model: cfg.model, groupId: gid, groupIdx: 0, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
      const msgB = { role: "assistant", content: "", thinking: "", model: cfg.model2, groupId: gid, groupIdx: 1, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId2 };
      s.messages.push(msgA, msgB);
      renderMessages();

      // ★ 1.23.1 修复：对比模式下工具调用会被声明但不执行，导致模型卡住。
      if (cfg.toolsEnabled) {
        setStatus("对比模式暂不支持工具调用，本轮已自动关闭工具");
      }
      const cmpOpts = { withTools: false, images: modelImages };
      if (cfg.compareConcurrent) {
        await Promise.all([
          runStream(msgA, false, cfg.model, gid, null, ragContext, cmpOpts),
          runStream(msgB, false, cfg.model2, gid, gid, ragContext, cmpOpts)
        ]);
      } else {
        await runStream(msgA, false, cfg.model, gid, null, ragContext, cmpOpts);
        await runStream(msgB, false, cfg.model2, gid, gid, ragContext, cmpOpts);
      }

      const lastTwo = s.messages.slice(-2);
      if (lastTwo.length === 2 && lastTwo[0].groupId === gid && lastTwo[1].groupId === gid) {
        s.messages = s.messages.slice(0, -2);
        s.messages.push({ role: "assistant", groupId: gid, time: Date.now(), skillId: currentSkillId, skillName: currentSkillName, compare: [{ model: cfg.model, content: msgA.content, thinking: msgA.thinking, usage: { promptTokens: msgA.promptTokens, completionTokens: msgA.completionTokens } }, { model: cfg.model2, content: msgB.content, thinking: msgB.thinking, usage: { promptTokens: msgB.promptTokens, completionTokens: msgB.completionTokens } }] });
      }
      recordUsageForMessage(msgA);
      recordUsageForMessage(msgB);
    } else {
      const aiMsg = { role: "assistant", content: "", thinking: "", model: cfg.model, time: Date.now(), ragSources: ragSources, skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
      s.messages.push(aiMsg); renderMessages();
      await runStreamWithTools(aiMsg, false, null, ragContext, modelImages);
      recordUsageForMessage(aiMsg);
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
    if (!lastMsg.versions) {
      // ★ 修复：第一个版本要连同工具调用与 token 用量一起存下来，
      //   否则切回旧版本时会丢失工具卡片、并沿用新版本的 token 数。
      lastMsg.versions = [{
        model: lastMsg.model,
        content: lastMsg.content,
        thinking: lastMsg.thinking || "",
        time: lastMsg.time,
        speed: lastMsg.speed,
        genTime: lastMsg.genTime || 0,
        toolCalls: Array.isArray(lastMsg.toolCalls) ? lastMsg.toolCalls : null,
        toolResults: Array.isArray(lastMsg.toolResults) ? lastMsg.toolResults : null,
        promptTokens: toTokenNum(lastMsg.promptTokens),
        completionTokens: toTokenNum(lastMsg.completionTokens),
        usageSource: lastMsg.usageSource || null
      }];
      lastMsg.currentVersion = 0;
    }
    lastMsg.model = useModel; lastMsg.content = ""; lastMsg.thinking = ""; lastMsg.time = Date.now(); lastMsg.speed = 0; lastMsg.providerId = pid;
    // ★ 修复：重新生成时必须清掉上一条的 token 用量。
    //   原来没有清，runStream 的 prevPTokens 会把上一次生成的用量当成"已有累计"加进来，
    //   于是每次重新生成的记账都越滚越大（换成别的模型时更明显：
    //   新模型的费用里凭空多算了旧模型的 token）。
    lastMsg.promptTokens = 0;
    lastMsg.completionTokens = 0;
    lastMsg.genTime = 0;
    lastMsg.toolCalls = null;
    lastMsg.toolResults = null;
    lastMsg._toolAcc = null;
    lastMsg.usageSource = null;
    cfg.modelProviderId = pid;
    generating = true; updateSendBtn(); abortCtrl = new AbortController();
    renderMessages();
    try {
      await runStream(lastMsg, false, useModel);
      recordUsageForMessage(lastMsg);
      lastMsg.versions.push({
        model: lastMsg.model,
        content: lastMsg.content,
        thinking: lastMsg.thinking || "",
        time: lastMsg.time,
        speed: lastMsg.speed,
        genTime: lastMsg.genTime || 0,
        toolCalls: Array.isArray(lastMsg.toolCalls) ? lastMsg.toolCalls : null,
        toolResults: Array.isArray(lastMsg.toolResults) ? lastMsg.toolResults : null,
        promptTokens: toTokenNum(lastMsg.promptTokens),
        completionTokens: toTokenNum(lastMsg.completionTokens),
        usageSource: lastMsg.usageSource || null
      });
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
  let editSources = null;
  // ★ 修复 1.22 的 bug：fetchRagContext 返回的是 { context, sources } 对象
  if (cfg.ragEnabled) {
    const ragRes = await fetchRagContext(newText);
    if (ragRes) { ragContext = ragRes.context; editSources = ragRes.sources; }
  }
  generating = true; updateSendBtn(); abortCtrl = new AbortController();
  try {
    const aiMsg = { role: "assistant", content: "", thinking: "", model: cfg.model, time: Date.now(), ragSources: editSources, skillId: currentSkillId, skillName: currentSkillName, providerId: cfg.modelProviderId };
    s.messages.push(aiMsg); renderMessages();
    await runStreamWithTools(aiMsg, false, null, ragContext, null);
    recordUsageForMessage(aiMsg);
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