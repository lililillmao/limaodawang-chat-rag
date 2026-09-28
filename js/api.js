// ============ 网络请求层 ============
// Ollama 对话 / 模型列表 / RAG 检索

async function fetchModels(){
  const sel = document.getElementById("modelSelect");
  const sel2 = document.getElementById("modelSelect2");
  try{
    const r = await fetch(cfg.url + "/api/tags");
    if(!r.ok) throw new Error(r.status);
    const data = await r.json();
    const models = (data.models || []).map(m => m.name);
    allModelsCache = models;
    if(!models.length){
      sel.innerHTML = '<option value="">（无模型）</option>';
      setStatus("未发现模型", true);
      return;
    }
    sel.innerHTML = models.map(m => `<option value="${m}" ${m===cfg.model?"selected":""}>${m}</option>`).join("");
    if(!cfg.model || !models.includes(cfg.model)){
      cfg.model = models[0];
      sel.value = cfg.model;
      saveLocal();
    }
    sel2.innerHTML = '<option value="">（选模型B）</option>' + models.map(m => `<option value="${m}" ${m===cfg.model2?"selected":""}>${m}</option>`).join("");
    if(!cfg.model2 || !models.includes(cfg.model2)){
      cfg.model2 = models.find(m => m !== cfg.model) || models[0];
      sel2.value = cfg.model2;
      saveLocal();
    }
    setStatus("已连接");
  }catch(e){
    sel.innerHTML = '<option value="">（连接失败）</option>';
    setStatus("连接失败，请先运行 .bat", true);
  }
}

async function streamRequest(model, messages, onChunk, onDone, onError, signal){
  try{
    const body = {
      model,
      messages,
      stream: true,
      options: {
        temperature: cfg.temperature,
        top_p: cfg.top_p,
        num_ctx: cfg.num_ctx || 8192,
        num_predict: cfg.num_predict || 1024,
        repeat_penalty: 1.15,
        repeat_last_n: 256,
        stop: ["<|im_end|>", "\n用户：", "\n\n用户："]
      }
    };
    const r = await fetch(cfg.url + "/api/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
      signal
    });
    if(!r.ok){
      let d = "";
      try{ const j = await r.json(); d = j.error || JSON.stringify(j); }catch(e){}
      throw new Error("HTTP " + r.status + (d ? "：" + d : ""));
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      buf += decoder.decode(value, {stream: true});
      let idx;
      while((idx = buf.indexOf("\n")) >= 0){
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if(!line) continue;
        try{
          const obj = JSON.parse(line);
          if(obj.message) onChunk(obj.message);
        }catch(e){}
      }
    }
    onDone && onDone();
  }catch(e){
    if(e.name === "AbortError"){ onError && onError(e, true); }
    else { onError && onError(e, false); }
  }
}

async function fetchRagContext(query){
  try{
    const url = `${getRagUrl()}/api/search?query=${encodeURIComponent(query)}&top_k=3`;
    const res = await fetch(url);
    if(!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if(data.results && data.results.length > 0){
      const contextText = data.results.map(r => `[来源: ${r.source || '未知'}]\n${r.content}`).join("\n\n---\n\n");
      const sources = data.results.map(r => {
        let name = r.source || '未知';
        name = name.split(/[\\/]/).pop();
        return {name, content: r.content};
      });
      return {context: contextText, sources, safety_flag: data.safety_flag};
    }
  }catch(e){
    console.error("⚠️ RAG 检索失败:", e);
  }
  return null;
}