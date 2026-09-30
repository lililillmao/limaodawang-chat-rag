// ★ 1.23：导出时带上工具调用记录与图片说明
function exportExtrasMarkdown(m){
  let out="";
  const imgs = (m && Array.isArray(m.images)) ? m.images : [];
  if(imgs.length) out += `> 🖼️ 附图 ${imgs.length} 张（图片数据不包含在导出文件内）\n\n`;
  const calls = (m && Array.isArray(m.toolCalls)) ? m.toolCalls : [];
  if(calls.length){
    const results = (m && m.toolResults) || [];
    out += `### 🔧 工具调用（${calls.length} 次）\n\n`;
    calls.forEach((c,i)=>{
      const name=(c.function&&c.function.name)||"未知";
      const res=results[i];
      out += `**${i+1}. ${name}**${res?(res.ok?" ✅":" ❌"):""}\n\n`;
      out += "```json\n" + ((c.function&&c.function.arguments)||"{}") + "\n```\n\n";
      if(res&&res.text) out += "结果：\n\n```\n" + res.text + "\n```\n\n";
    });
  }
  return out;
}
function exportExtrasTxt(m){
  let out="";
  const imgs = (m && Array.isArray(m.images)) ? m.images : [];
  if(imgs.length) out += `[附图 ${imgs.length} 张]\n`;
  const calls = (m && Array.isArray(m.toolCalls)) ? m.toolCalls : [];
  if(calls.length){
    const results = (m && m.toolResults) || [];
    calls.forEach((c,i)=>{
      const name=(c.function&&c.function.name)||"未知";
      const res=results[i];
      out += `[工具调用] ${name}${res?(res.ok?" 成功":" 失败"):""} 参数: ${((c.function&&c.function.arguments)||"{}")}\n`;
      if(res&&res.text) out += `[工具结果] ${String(res.text).split("\n")[0].slice(0,200)}\n`;
    });
  }
  return out;
}

// ============ 导出 + 备份恢复 ============

function backupAll(){const data={version:"1.23",savedAt:new Date().toISOString(),cfg:cfg,sessions:sessions,presets:presets,drafts:drafts};const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");a.download=`聊天备份_${ts}.json`;a.click();URL.revokeObjectURL(a.href);setStatus("已备份全部数据");}

async function restoreAll(file){
  try{
    const text=await file.text();const data=JSON.parse(text);
    if(!data.sessions||!Array.isArray(data.sessions))throw new Error("文件格式不对");
    if(!confirm("恢复会覆盖当前所有对话、预设和设置，确定继续吗？"))return;
    if(data.cfg)cfg={...DEFAULT_CFG,...data.cfg};
    sessions=data.sessions;presets=Array.isArray(data.presets)?data.presets:[];drafts=data.drafts&&typeof data.drafts==="object"?data.drafts:{};
    if(!cfg.quickPrompts||!Array.isArray(cfg.quickPrompts))cfg.quickPrompts=["翻译","总结","改代码"];
    if(!cfg.emoMap||typeof cfg.emoMap!=="object"||Array.isArray(cfg.emoMap))cfg.emoMap={};
    if(!cfg.ragUrl)cfg.ragUrl=DEFAULT_CFG.ragUrl;
    if(!cfg.num_predict)cfg.num_predict=1024;
    currentSessionId=sessions[0]?.id||null;
    saveLocal();saveToDisk();applyFontSize();applyTheme();applyAccentColor();
    // ★ 修复：模型下拉框的 option value 是 "providerId|modelName" 的复合格式
    //   （见 api.js 里 fetchModels），这里原来只写了 cfg.model，浏览器匹配不到任何
    //   option，于是顶栏显示空白，与真实生效的模型不一致，用户会误以为没选模型。
    //   顺便补一次 fetchModels()，让下拉列表与恢复后的配置重新对齐。
    try{
      const sel=document.getElementById("modelSelect");
      if(sel){
        const want=(cfg.modelProviderId&&cfg.model)?`${cfg.modelProviderId}|${cfg.model}`:"";
        if(want&&Array.from(sel.options).some(o=>o.value===want))sel.value=want;
      }
      if(typeof fetchModels==="function")fetchModels();
    }catch(e){console.warn("⚠️ 恢复后同步模型下拉框失败",e)}
    setCompareMode(cfg.compareMode || false);
    // ★ 修复：恢复备份时要一起恢复"当前启用的预设"。
    //   cfg.activePresetId 会被 merge 进来，但内存变量 currentPresetId 没人赋值，
    //   而 resolveParam / getActiveSystemPrompt 都只读 currentPresetId，
    //   于是恢复后预设层静默失效（顶栏徽章也是空的，用户察觉不到）。
    if(typeof restoreActivePreset==="function"){try{restoreActivePreset()}catch(e){console.warn("⚠️ 恢复预设失败",e)}}
    else if(typeof updatePresetBadge==="function"){try{updatePresetBadge()}catch(e){}}
    renderSessions();renderPresets();renderMessages();renderQuickPrompts();renderTplList();renderEmoList();updateRagBadge();updateCtxInfo();
    setStatus("已恢复");alert("恢复成功！共 "+sessions.length+" 个对话。");
  }catch(e){alert("恢复失败："+e.message)}
}

function exportSingleAnswer(payload){
  const s=getCurrentSession();const modelName=payload.model||cfg.model||"AI";
  const skillLine = payload.skillName ? `> Skill：🧩 ${payload.skillName}\n` : "";
  let md=`# ${modelName} 的回答\n\n`;md+=`> 来源对话：${s?s.title:"（无）"}\n${skillLine}> 导出时间：${new Date().toLocaleString()}\n\n---\n\n`;
  if(payload.thinking)md+=`<details>\n<summary>💭 思考（${payload.thinking.length} 字）</summary>\n\n${payload.thinking}\n\n</details>\n\n`;
  md+=replaceEmo(payload.content||"")+"\n";
  const safe=(modelName).replace(/[\\/:*?"<>|]/g,"_");const titleSafe=((s?s.title:"对话")||"对话").replace(/[\\/:*?"<>|]/g,"_").slice(0,40);
  const blob=new Blob([md],{type:"text/markdown;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${titleSafe}_${safe}.md`;a.click();URL.revokeObjectURL(a.href);setStatus("已导出这条回答");
}

function exportTxt(){
  const s=getCurrentSession();if(!s||!s.messages.length){alert("没有对话可以导出");return}
  const lines=[];lines.push(`# ${s.title||"对话"}`);lines.push(`导出时间：${new Date().toLocaleString()}`);lines.push(`模型：${cfg.model||""}`);
  if(currentPresetId){const p=presets.find(x=>x.id===currentPresetId);if(p)lines.push(`主预设：${p.name}`)}
  lines.push("");lines.push("=".repeat(50));
  for(const m of s.messages){
    if(m.isSummary){lines.push("");lines.push("【上下文摘要】");lines.push(m.content||"");lines.push("");continue;}
    if(m.role==="user"){lines.push("");lines.push("【你】");lines.push(m.content||"");lines.push("");}
    else if(m.compare){const skillTag = m.skillName ? ` · 🧩 ${m.skillName}` : "";lines.push("");lines.push(`【模型对比${skillTag}】`);for(const c of m.compare){lines.push("");lines.push(`—— ${c.model} ——`);if(c.thinking)lines.push(`[思考] ${c.thinking}`);lines.push(replaceEmo(c.content||""));}lines.push("");}
    else{const skillTag = m.skillName ? ` · 🧩 ${m.skillName}` : "";lines.push("");lines.push(`【AI · ${m.model||cfg.model}${skillTag}】`);const {thinking,content}=getThinkAndContent(m);if(thinking)lines.push(`[思考] ${thinking}`);const extras=exportExtrasTxt(m);if(extras)lines.push(extras);lines.push(replaceEmo(content||""));lines.push("");}
  }
  const blob=new Blob([lines.join("\n")],{type:"text/plain;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(s.title||"对话")+".txt";a.click();URL.revokeObjectURL(a.href);setStatus("已导出 TXT");
}

function exportMarkdown(){
  const s=getCurrentSession();if(!s||!s.messages.length){alert("没有对话可以导出");return}
  let md=`# ${s.title}\n\n> 导出时间：${new Date().toLocaleString()}\n> 模型：${cfg.model}\n`;
  if(currentPresetId){const p=presets.find(x=>x.id===currentPresetId);if(p)md+=`> 主预设：${p.name}\n`}
  md+=`\n---\n\n`;
  for(const m of s.messages){
    if(m.isSummary){md+=`## 📝 上下文摘要\n\n${m.content}\n\n`}
    else if(m.role==="user"){md+=`## 👤 你\n\n${m.content}\n\n`}
    else if(m.compare){const skillTag = m.skillName ? ` · 🧩 ${m.skillName}` : "";md+=`## ⚖️ 对比${skillTag}\n\n`;for(const c of m.compare){md+=`### 🤖 ${c.model}\n\n`;if(c.thinking)md+=`<details>\n<summary>💭 思考（${c.thinking.length} 字）</summary>\n\n${c.thinking}\n\n</details>\n\n`;md+=`${replaceEmo(c.content)}\n\n`;}}
    else{const skillTag = m.skillName ? ` · 🧩 ${m.skillName}` : "";md+=`## 🤖 ${m.model||cfg.model}${skillTag}\n\n`;const {thinking,content}=getThinkAndContent(m);if(thinking)md+=`<details>\n<summary>💭 思考（${thinking.length} 字）</summary>\n\n${thinking}\n\n</details>\n\n`;md+=exportExtrasMarkdown(m);md+=`${replaceEmo(content)}\n\n`;}
  }
  const blob=new Blob([md],{type:"text/markdown;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(s.title||"对话")+".md";a.click();URL.revokeObjectURL(a.href);
}