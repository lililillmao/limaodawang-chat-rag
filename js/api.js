// ============ 网络请求层 ============
// 多平台适配：Ollama / OpenAI 兼容接口

async function fetchModels() {
  const sel = document.getElementById("modelSelect");
  const sel2 = document.getElementById("modelSelect2");
  const allModels = [];

  for (const provider of cfg.providers) {
    try {
      let models = [];
      if (provider.type === "ollama") {
        const r = await fetch(provider.baseUrl.replace(/\/$/, "") + "/api/tags");
        if (r.ok) {
          const data = await r.json();
          models = (data.models || []).map(m => ({ providerId: provider.id, providerName: provider.name, modelName: m.name }));
        }
      } else {
        const base = provider.baseUrl.replace(/\/$/, "");
        const r = await fetch(base + "/models", {
          headers: provider.apiKey ? { "Authorization": "Bearer " + provider.apiKey } : {}
        });
        if (r.ok) {
          const data = await r.json();
          models = (data.data || []).map(m => ({ providerId: provider.id, providerName: provider.name, modelName: m.id }));
        }
      }
      allModels.push(...models);
    } catch (e) {
      console.warn(`平台 ${provider.name} 连接失败`, e);
    }
  }

  allModelsCache = allModels;

  if (!allModels.length) {
    sel.innerHTML = '<option value="">（无可用模型）</option>';
    setStatus("未发现模型，请检查平台配置", true);
    return;
  }

  const grouped = {};
  for (const m of allModels) {
    if (!grouped[m.providerId]) grouped[m.providerId] = { name: m.providerName, models: [] };
    grouped[m.providerId].models.push(m.modelName);
  }

  let html = "";
  for (const pid in grouped) {
    html += `<optgroup label="${escapeHtml(grouped[pid].name)}">`;
    html += grouped[pid].models.map(m => `<option value="${pid}|${m}">${m}</option>`).join("");
    html += `</optgroup>`;
  }

  sel.innerHTML = html;
  sel2.innerHTML = '<option value="">（选模型B）</option>' + html;

  const currentVal = cfg.modelProviderId && cfg.model ? `${cfg.modelProviderId}|${cfg.model}` : "";
  if (currentVal && allModels.some(m => `${m.providerId}|${m.modelName}` === currentVal)) {
    sel.value = currentVal;
  } else if (allModels.length) {
    const first = allModels[0];
    sel.value = `${first.providerId}|${first.modelName}`;
    cfg.modelProviderId = first.providerId;
    cfg.model = first.modelName;
    saveLocal();
  }

  if (cfg.model2) {
    const val2 = cfg.modelProviderId2 && cfg.model2 ? `${cfg.modelProviderId2}|${cfg.model2}` : "";
    if (val2 && allModels.some(m => `${m.providerId}|${m.modelName}` === val2)) sel2.value = val2;
  }

  setStatus("已连接");
  updateCtxInfo();
}

// ★ 修复：加了 providerId 参数，跨平台对比才能正常工作
// ★ 1.23：新增第 8 个参数 opts = { tools, toolChoice }
// ★ 1.23.1：新增对 Ollama tool_calls 对象型 arguments 的兼容
async function streamRequest(model, messages, onChunk, onDone, onError, signal, providerId = null, opts = null) {
  const pid = providerId || cfg.modelProviderId || currentProviderId;
  const provider = cfg.providers.find(p => p.id === pid) || cfg.providers[0];

  if (!provider) {
    onError(new Error("未找到对应的平台配置"), false);
    return;
  }

  const isOllama = provider.type === "ollama";

  try {
    const ep = getEffectiveParams();
    const body = {
      model,
      messages,
      stream: true,
      options: {
        temperature: ep.temperature,
        top_p: ep.top_p,
        num_ctx: ep.num_ctx || 8192,
        num_predict: ep.num_predict || 1024,
      }
    };

    if (isOllama) {
      body.options.repeat_penalty = 1.15;
      body.options.repeat_last_n = 256;
      body.options.stop = ["<|im_end|>", "\n用户：", "\n\n用户："];
    }

    // ★ 1.23：工具声明
    if (opts && Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      if (!isOllama) body.tool_choice = opts.toolChoice || "auto";
    }

    // ★ 1.23：让 OpenAI 兼容平台在流式模式下也返回 usage
    if (!isOllama) body.stream_options = { include_usage: true };

    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const endpoint = isOllama ? "/api/chat" : resolveOpenAIEndpoint(provider.baseUrl);

    const headers = { "Content-Type": "application/json" };
    if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;

    const r = await fetch(isOllama ? baseUrl + endpoint : endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });

    if (!r.ok) {
      let d = "";
      try { const j = await r.json(); d = j.error?.message || j.error || JSON.stringify(j); } catch (e) {}
      throw new Error("HTTP " + r.status + (d ? "：" + d : ""));
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      if (isOllama) {
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message) {
              onChunk(obj.message);
            }
            // ★ 1.23：Ollama 在最后一帧（obj.done === true）才给出真实 token 用量。
            if (obj.done) {
              const pt = obj.prompt_eval_count;
              const ct = obj.eval_count;
              if (pt != null || ct != null) {
                onChunk({
                  usage: {
                    prompt_tokens: pt || 0,
                    completion_tokens: ct || 0,
                    total_tokens: (pt || 0) + (ct || 0),
                    source: "ollama"
                  }
                });
              }
            }
          } catch (e) {}
        }
      } else {
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith("data:")) continue;
          const dataStr = line.replace(/^data:\s*/, "");
          if (dataStr === "[DONE]") continue;
          try {
            const obj = JSON.parse(dataStr);

            // ★ 1.23：usage 优先独立处理
            if (obj.usage) {
              onChunk({
                usage: {
                  prompt_tokens: obj.usage.prompt_tokens || 0,
                  completion_tokens: obj.usage.completion_tokens || 0,
                  total_tokens: obj.usage.total_tokens || 0,
                  source: "openai"
                }
              });
            }

            const choice = obj.choices && obj.choices[0];
            if (choice) {
              const delta = choice.delta || {};
              const msg = {
                content: delta.content || "",
                thinking: delta.reasoning_content || delta.reasoning || ""
              };
              // ★ 1.23：工具调用增量分片透传，并且必须带上 index。
              if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
                msg.tool_calls = delta.tool_calls.map((tc, i) => ({
                  index: tc.index != null ? tc.index : i,
                  id: tc.id || "",
                  type: tc.type || "function",
                  function: {
                    name: (tc.function && tc.function.name) || "",
                    arguments: (tc.function && tc.function.arguments) || ""
                  }
                }));
              }
              if (choice.finish_reason) {
                msg.finish_reason = choice.finish_reason;
              }
              onChunk(msg);
            }
          } catch (e) {}
        }
      }
    }
    onDone && onDone();
  } catch (e) {
    if (e.name === "AbortError") { onError && onError(e, true); }
    else { onError && onError(e, false); }
  }
}

// ★ 1.23：工具调用累计器
// ★ 1.23.1：兼容 Ollama 老版本返回的对象型 arguments
function accumulateToolCalls(store, incoming) {
  if (!Array.isArray(incoming)) return store || [];
  const list = Array.isArray(store) ? store : [];
  for (const tc of incoming) {
    const i = (tc.index != null) ? tc.index : 0;
    if (!list[i]) list[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
    const slot = list[i];
    if (tc.id) slot.id = tc.id;
    if (tc.type) slot.type = tc.type;
    if (tc.function) {
      // 工具名拼接（识别重复推送）
      if (tc.function.name) {
        const frag = tc.function.name;
        const cur = slot.function.name;
        if (!cur) {
          slot.function.name = frag;
        } else if (frag === cur || frag.startsWith(cur)) {
          slot.function.name = frag.length > cur.length ? frag : cur;
        } else if (cur.endsWith(frag)) {
          // 重复推送同一片段：忽略
        } else {
          slot.function.name = cur + frag;
        }
      }
      // ★ 1.23.1 修复：Ollama 老版本返回的是对象而非字符串，
      //   直接 += 会变成 "[object Object]"，必须按类型转换。
      if (tc.function.arguments) {
        const frag = (typeof tc.function.arguments === "string")
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        slot.function.arguments += frag;
      }
    }
  }
  return list;
}

// ★ 1.23：把工具调用列表归一成可直接写进 message 的干净结构（丢掉 index）
function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(Boolean).map((tc, i) => ({
    id: tc.id || ("call_" + i),
    type: "function",
    function: {
      name: (tc.function && tc.function.name) || "",
      arguments: (tc.function && tc.function.arguments) || "{}"
    }
  })).filter(tc => tc.function.name);
}

// ★ 1.23：multimodal 消息构造
// ★ 1.23.1：历史消息里的图片可能没有 b64，从 dataUrl 现场切
function buildMultimodalUserMessage(text, images, providerType) {
  if (!images || !images.length) return { role: "user", content: text };
  if (providerType === "ollama") {
    const b64List = images.map(im => im.b64 || (String(im.dataUrl || "").split(",")[1] || "")).filter(Boolean);
    return { role: "user", content: text, images: b64List };
  }
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const im of images) {
    if (im && im.dataUrl) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
  }
  return { role: "user", content: parts };
}

async function testProviderConnection(provider) {
  try {
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    let url = provider.type === "ollama" ? baseUrl + "/api/tags" : baseUrl + "/models";
    let headers = {};
    if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      return { ok: true, msg: "连接成功" };
    } else {
      const text = await res.text().catch(() => "");
      return { ok: false, msg: `HTTP ${res.status}: ${text.slice(0, 50)}` };
    }
  } catch (e) {
    return { ok: false, msg: e.name === "AbortError" ? "连接超时" : e.message };
  }
}

async function fetchRagContext(query) {
  try {
    const params = new URLSearchParams({ query, top_k: 3 });
    if (currentSkillIds.length === 1 && currentSkillScope === "self") {
      params.set("skill_id", currentSkillIds[0]);
      params.set("scope", "self");
    } else {
      params.set("scope", "all");
    }
    const url = `${getRagUrl()}/api/search?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const contextText = data.results.map(r => `[来源: ${r.source || '未知'}]\n${r.content}`).join("\n\n---\n\n");
      const sources = data.results.map(r => {
        const fullPath = r.source || "";
        let name = fullPath || "未知";
        name = name.split(/[\\/]/).pop();
        return {
          name,
          content: r.content,
          fullPath,
          distance: (r.distance != null ? r.distance : null),
          skillId: r.skill_id || "",
          isSafety: r.source === "safety_override",
        };
      });
      return { context: contextText, sources, safety_flag: data.safety_flag };
    }
  } catch (e) {
    console.error("⚠️ RAG 检索失败:", e);
  }
  return null;
}

async function openLocalFolder(fullPath) {
  if (!fullPath) return;
  try {
    const res = await fetch(`${getRagUrl()}/api/open_folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath })
    });
    const data = await res.json();
    if (!res.ok) {
      alert("打开失败：" + (data.detail || res.status));
      return;
    }
    setStatus("已在文件管理器中打开");
  } catch (e) {
    alert("请求失败：" + e.message);
  }
}

// ============ ★ 临时 RAG 辅助 ============

async function parseTempFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch(`${getRagUrl()}/api/parse_temp_file`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("⚠️ 解析临时文件失败:", e);
    return null;
  }
}

async function embedText(text) {
  try {
    const res = await fetch(`${getRagUrl()}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data.embedding;
  } catch (e) {
    console.error("⚠️ 获取查询向量失败:", e);
    return null;
  }
}

function cosineSimilarity(v1, v2) {
  if (!v1 || !v2 || v1.length !== v2.length) return 0;
  let dot = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    m1 += v1[i] * v1[i];
    m2 += v2[i] * v2[i];
  }
  if (m1 === 0 || m2 === 0) return 0;
  return dot / (Math.sqrt(m1) * Math.sqrt(m2));
}

// ============ ★ 长期记忆接口 ============

async function fetchMemories() {
  try {
    const res = await fetch(`${getRagUrl()}/api/memory/list`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    memories = data.memories || [];
    return memories;
  } catch (e) {
    console.error("⚠️ 获取记忆列表失败:", e);
    return [];
  }
}

async function addMemory(content, source = "手动添加") {
  try {
    const res = await fetch(`${getRagUrl()}/api/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, source })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("⚠️ 添加记忆失败:", e);
    return null;
  }
}

async function deleteMemory(id) {
  try {
    const res = await fetch(`${getRagUrl()}/api/memory/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: id })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("⚠️ 删除记忆失败:", e);
    return null;
  }
}

async function searchMemories(query, top_k = 3) {
  try {
    const params = new URLSearchParams({ query, top_k });
    const res = await fetch(`${getRagUrl()}/api/memory/search?${params.toString()}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    console.error("⚠️ 检索记忆失败:", e);
    return [];
  }
}