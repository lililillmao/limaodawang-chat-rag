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
async function streamRequest(model, messages, onChunk, onDone, onError, signal, providerId = null) {
  const pid = providerId || cfg.modelProviderId || currentProviderId;
  const provider = cfg.providers.find(p => p.id === pid) || cfg.providers[0];

  if (!provider) {
    onError(new Error("未找到对应的平台配置"), false);
    return;
  }

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

    if (provider.type === "ollama") {
      body.options.repeat_penalty = 1.15;
      body.options.repeat_last_n = 256;
      body.options.stop = ["<|im_end|>", "\n用户：", "\n\n用户："];
    }

    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const endpoint = provider.type === "ollama" ? "/api/chat" : "/v1/chat/completions";

    const headers = { "Content-Type": "application/json" };
    if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;

    const r = await fetch(baseUrl + endpoint, {
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

      if (provider.type === "ollama") {
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message) onChunk(obj.message);
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
            if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
              const delta = obj.choices[0].delta;
              const msg = {
                content: delta.content || "",
                thinking: delta.reasoning_content || delta.reasoning || ""
              };
              onChunk(msg);
            }
            if (obj.usage) {
              onChunk({ usage: obj.usage });
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