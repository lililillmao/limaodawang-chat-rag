// ============ 对话核心逻辑 ============

// ★ 1.23.2：检测模型把工具调用当文本输出的失败模式
//   qwen2.5:7b 在 Ollama 上有时会把 tool_call 内容直接输出到 content 里
//   （例如 `{"name": "get_current_time", "arguments": {}}`），
//   本函数从文本里提取这些"伪工具调用"，交给正常的多轮流程处理。
//
// ★ 修复 #6：原实现用一个单层正则匹配 arguments，形如 `\{[^{}]*\}`，
//   只能匹配"一层花括号"。当模型输出的 arguments 含嵌套对象时
//   （例如 `{"query": "cat", "opts": {"top_k": 3}}`），整段匹配失败，
//   工具调用被当成普通文本，工具不会执行。
//   现在改用"括号平衡扫描"从 `"arguments":` 之后手工配对 { }，
//   并兼容数组和字符串形式。
function extractTextToolCalls(text) {
  if (!text) return [];
  const results = [];
  // 先找所有 "name": "xxx" 的位置，再从其后找 "arguments":
  const nameRe = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    const name = m[1];
    if (typeof getToolByName !== "function" || !getToolByName(name)) continue;
    // 在 name 之后寻找最近的 "arguments":
    const after = text.slice(m.index);
    const argKeyMatch = after.match(/"arguments"\s*:\s*/);
    if (!argKeyMatch) continue;
    const argStart = m.index + argKeyMatch.index + argKeyMatch[0].length;
    // 从 argStart 开始做括号平衡扫描，取出一段完整的 JSON 值
    const extracted = _scanJsonValue(text, argStart);
    if (!extracted) continue;
    let argsStr = extracted.value;
    // 字符串型参数视为无效，用空对象兜底
    if (extracted.kind === "string") argsStr = "{}";
    results.push({
      id: "call_text_" + Date.now() + "_" + results.length,
      type: "function",
      function: { name, arguments: argsStr }
    });
    // 让下一轮正则从这段 arguments 之后继续，避免同一个 name 被重复匹配
    nameRe.lastIndex = Math.max(nameRe.lastIndex, argStart + argsStr.length);
  }
  return results;
}

// ★ 新增（配合 #6）：从 str[start] 开始扫一段 JSON 值。
//   - 遇到 { 或 [ 时，用配对栈扫到平衡结束
//   - 遇到 " 时，扫到未转义的结束引号
//   - 返回 { value, kind }，kind 为 "object" | "array" | "string" | "other"
//   扫不到完整结构时返回 null。
function _scanJsonValue(str, start) {
  let i = start;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (i >= str.length) return null;
  const first = str[i];

  // 字符串
  if (first === '"') {
    let j = i + 1;
    while (j < str.length) {
      if (str[j] === '\\') { j += 2; continue; }
      if (str[j] === '"') return { value: str.slice(i, j + 1), kind: "string" };
      j++;
    }
    return null;
  }

  // 对象 / 数组
  if (first === '{' || first === '[') {
    const open = first;
    const close = first === '{' ? '}' : ']';
    const stack = [close];
    let j = i + 1;
    let inStr = false;
    while (j < str.length) {
      const c = str[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') {
          if (stack.length && stack[stack.length - 1] === c) {
            stack.pop();
            if (!stack.length) {
              return { value: str.slice(i, j + 1), kind: open === '{' ? "object" : "array" };
            }
          }
        }
      }
      j++;
    }
    return null;
  }

  // 其它（数字 / 布尔 / null）：扫到下一个逗号或右括号为止
  let j = i;
  while (j < str.length && !/[,\]}\s]/.test(str[j])) j++;
  return { value: str.slice(i, j), kind: "other" };
}

// ★ 1.23.1：针对 Ollama 与 OpenAI 的工具消息格式差异做了分支处理
// ★ 1.23.2：改为从 m._toolHistory 重建工具交换序列，多轮顺序正确；
//   不再依赖 s.messages 里的 role:"tool" 消息（那会导致 localStorage 无限增长）
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
      const parts = m.compare
        .filter(c => c && (c.content || c.thinking))
        .map(c => `【${(c && c.model) || "模型"}】\n${(c && c.content) || ""}`)
        .join("\n\n---\n\n");
      if (parts) list.push({ role: "assistant", content: parts });
      return;
    }
    if (excludeGroupId && m.groupId === excludeGroupId) return;

    // ★ 1.23.2：兼容老数据 —— 如果 s.messages 里还有 role:"tool" 的历史残留（升级前保存的），
    //   继续按老逻辑回灌，但新会话不再产生这类消息。
    if (m.role === "tool") {
      if (isOllama) {
        list.push({ role: "tool", content: m.content || "" });
      } else {
        list.push({ role: "tool", tool_call_id: m.toolCallId || "", content: m.content || "" });
      }
      return;
    }

    // ★ 带工具调用的 assistant 消息
    if (m.role === "assistant") {
      const _hasToolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
      const _hasHistory = Array.isArray(m._toolHistory) && m._toolHistory.length > 0;
      const _hasContent = !!(m.content || "").trim();
      const _hasThinking = !!(m.thinking || "").trim();

      // 完全空白的 assistant 消息直接丢弃（对比模式占位、中断产生的空消息等）
      if (!_hasToolCalls && !_hasHistory && !_hasContent && !_hasThinking) return;

      // ★ 1.23.2：优先从 _toolHistory 重建完整的工具交换序列
      //   每个 assistant 条目 = 一轮中间生成（带 tool_calls）
      //   每个 tool 条目 = 该轮工具执行结果
      //   这样多轮工具调用时，模型看到的顺序才是 正确 的：
      //     assistant(轮1 tool_calls) → tool(轮1 结果) → assistant(轮2 tool_calls) → tool(轮2 结果) → ...
      if (_hasHistory) {
        for (const entry of m._toolHistory) {
          if (entry.role === "assistant" && Array.isArray(entry.toolCalls) && entry.toolCalls.length) {
            const mid = { role: "assistant", content: "" };
            if (isOllama) {
              mid.tool_calls = entry.toolCalls.map(tc => {
                let argsObj = {};
                try { argsObj = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { argsObj = {}; }
                if (!argsObj || typeof argsObj !== "object" || Array.isArray(argsObj)) argsObj = {};
                return { function: { name: (tc.function && tc.function.name) || "", arguments: argsObj } };
              });
            } else {
              mid.tool_calls = entry.toolCalls;
            }
            list.push(mid);
          } else if (entry.role === "tool") {
            if (isOllama) {
              list.push({ role: "tool", content: entry.text || "" });
            } else {
              list.push({ role: "tool", tool_call_id: entry.toolCallId || "", content: entry.text || "" });
            }
          }
        }
        // 最终 assistant 正文（如果有）
        if (_hasContent) {
          list.push({ role: "assistant", content: m.content });
        }
        return;
      }

      // 老路径：只有 toolCalls 没有 _toolHistory（向后兼容 / 手工构造的消息）
      if (_hasToolCalls) {
        const item = { role: "assistant", content: m.content || "" };
        if (isOllama) {
          item.tool_calls = m.toolCalls.map(tc => {
            let argsObj = {};
            try { argsObj = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { argsObj = {}; }
            if (!argsObj || typeof argsObj !== "object" || Array.isArray(argsObj)) argsObj = {};
            return { function: { name: (tc.function && tc.function.name) || "", arguments: argsObj } };
          });
        } else {
          item.tool_calls = m.toolCalls;
        }
        list.push(item);
        return;
      }

      // 普通 assistant 消息
      list.push({ role: "assistant", content: m.content });
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
  });

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
  const msgs = buildMessages(isContinue, groupIdToExclude, ragContext, {
    images: options.images || null,
    providerType
  });
  abortCtrl = abortCtrl || new AbortController();
  const localCtrl = abortCtrl;
  const startTime = Date.now();
  const prevGenTime = aiMsg.genTime || 0;
  const prevSpeed = aiMsg.speed || 0;
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
        if (p > roundPTokens) roundPTokens = p;
        if (c > roundCTokens) roundCTokens = c;
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
      if (aborted) { if (localCtrl && localCtrl.signal.aborted) setStatus("已停止"); }
      else { aiMsg.content += `\n\n> ⚠️ 出错：${e.message}`; setStatus("出错", true); }
    },
    localCtrl.signal,
    aiMsg.providerId || null,
    reqOpts
  );

  return { triggeredTools, aborted: !!(localCtrl && localCtrl.signal && localCtrl.signal.aborted) };
}

// ★ 1.23：带工具调用的多轮生成
// ★ 1.23.2：不再往 s.messages 塞 role:"tool" 消息，改为写入 aiMsg._toolHistory
//   - 避免 localStorage 无限增长（旧工具结果永久堆积）
//   - 保证多轮工具调用的顺序正确（每一轮独立记录）
//   - contextTokens 不再被隐藏消息虚高
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

    if (!isTextCall) {
      aiMsg.content = contentBefore;
      aiMsg.thinking = thinkingBefore;
    }

    if (round === maxRounds) {
      aiMsg.content += `\n\n> ⚠️ 工具调用已达上限（${maxRounds} 轮），自动停止。可在「⚙ 设置」中调大「最大工具轮次」。`;
      if (useTools) toolRoundCurrent = 0;
      return;
    }

    // ★ 1.23.2：把本轮 assistant 带 tool_calls 的记录写入 _toolHistory
    aiMsg._toolHistory = aiMsg._toolHistory || [];
    aiMsg._toolHistory.push({
      role: "assistant",
      toolCalls: calls.slice()
    });

    for (const call of calls) {
      if (abortCtrl && abortCtrl.signal.aborted) { if (useTools) toolRoundCurrent = 0; return; }

      const toolName = call.function && call.function.name;
      setStatus(`🔧 正在执行：${getToolDisplayName(toolName)}…`);
      s.updatedAt = Date.now();
      renderMessages();

      const result = await executeToolCall(call);
      const text = toolResultToText(result);

      // UI 用的扁平数组（保持 buildToolCallsHtml 兼容）
      aiMsg.toolResults = aiMsg.toolResults || [];
      aiMsg.toolResults.push({
        id: call.id,
        name: toolName,
        args: call.function ? call.function.arguments : "",
        ok: !!result.ok,
        ms: result.ms || 0,
        text
      });

      // ★ 1.23.2：模型消息用的顺序记录（取代 s.messages.push role:"tool"）
      aiMsg._toolHistory.push({
        role: "tool",
        toolCallId: call.id,
        name: toolName,
        text
      });
    }

    s.updatedAt = Date.now();
    saveLocal(); saveToDisk();
    renderMessages();
    setStatus("🔧 已获取工具结果，继续生成…");
  }

  if (useTools) toolRoundCurrent = 0;
}

// ★ 修复 #7：记忆提取并发锁。
//   原来没有任何保护：对比模式下两个 runStream 几乎同时完成，会并行调用
//   extractMemoryFromConversation；两边都读到旧的 memories 快照，
//   `some(m => m.content === line)` 都为 false，于是同一条记忆被 addMemory 两遍。
//   加一个模块级布尔锁，保证同一时刻只有一次提取在跑。
let _extractingMemory = false;

async function extractMemoryFromConversation() {
  if (!cfg.memoryEnabled || !cfg.memoryExtract) return;
  // ★ 修复 #7：并发锁。若已有一次提取在进行，直接返回。
  if (_extractingMemory) return;
  const s = getCurrentSession();
  if (!s || s.messages.length < 2) return;

  _extractingMemory = true;
  try {
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
          // ★ 修复 #7：写入前再 fetch 一次最新的 memories，避免基于旧快照去重
          try { await fetchMemories(); } catch (e) { /* 忽略，用内存里的兜底 */ }
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
  } finally {
    // ★ 修复 #7：无论成功失败都要释放锁
    _extractingMemory = false;
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
  const pendingImages = (typeof tempImages !== "undefined" && Array.isArray(tempImages)) ? tempImages.length : 0;
  if ((!text && !pendingImages) || generating) return;
  if (quoteState) { const quoted = quoteState.text.split("\n").map(l => "> " + l).join("\n"); text = `${quoted}\n\n${text}`.trim(); clearQuote(); }
  const displayText = text || (pendingImages ? "（图片）" : "");
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

  const sendImages = (typeof tempImages !== "undefined" && tempImages.length) ? tempImages.slice() : [];
  const userMsg = { role: "user", content: displayText, time: Date.now() };
  if (sendImages.length) {
    userMsg.images = sendImages.map(im => ({ name: im.name, mime: im.mime, dataUrl: im.dataUrl }));
  }
  s.messages.push(userMsg);

  if (s.title === "新对话") s.title = (text || displayText).slice(0, 20) || "新对话";
  s.updatedAt = Date.now();
  input.value = ""; autoResize(input);
  saveDraft();
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
      // ★ 修复：第一个版本要连同工具调用、工具历史与 token 用量一起存下来
      lastMsg.versions = [{
        model: lastMsg.model,
        content: lastMsg.content,
        thinking: lastMsg.thinking || "",
        time: lastMsg.time,
        speed: lastMsg.speed,
        genTime: lastMsg.genTime || 0,
        toolCalls: Array.isArray(lastMsg.toolCalls) ? lastMsg.toolCalls : null,
        toolResults: Array.isArray(lastMsg.toolResults) ? lastMsg.toolResults : null,
        // ★ 1.23.2：_toolHistory 也要进版本快照，否则切版本后模型消息序列会缺工具交换
        toolHistory: Array.isArray(lastMsg._toolHistory) ? lastMsg._toolHistory : null,
        promptTokens: toTokenNum(lastMsg.promptTokens),
        completionTokens: toTokenNum(lastMsg.completionTokens),
        usageSource: lastMsg.usageSource || null
      }];
      lastMsg.currentVersion = 0;
    }
    lastMsg.model = useModel; lastMsg.content = ""; lastMsg.thinking = ""; lastMsg.time = Date.now(); lastMsg.speed = 0; lastMsg.providerId = pid;
    lastMsg.promptTokens = 0;
    lastMsg.completionTokens = 0;
    lastMsg.genTime = 0;
    lastMsg.toolCalls = null;
    lastMsg.toolResults = null;
    lastMsg._toolAcc = null;
    lastMsg._toolHistory = null;  // ★ 1.23.2
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
        // ★ 1.23.2
        toolHistory: Array.isArray(lastMsg._toolHistory) ? lastMsg._toolHistory : null,
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