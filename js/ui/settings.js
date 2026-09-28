// ============ 设置面板 + 预设 + 模板 + 颜文字 ============

function openSettings(){
  fetch(`${getRagUrl()}/api/config`)
    .then(res => res.json())
    .then(data => {
      const el = document.getElementById("cfgSkillDir");
      if(el) el.value = data.skill_dir || "";
    })
    .catch(e => console.warn("获取后端配置失败", e));
  document.getElementById("cfgUrl").value=cfg.url;
  document.getElementById("cfgRagUrl").value=cfg.ragUrl||DEFAULT_CFG.ragUrl;
  document.getElementById("cfgDir").value=cfg.dir||"（未选择）";document.getElementById("cfgSys").value=cfg.system||"";
  document.getElementById("cfgTemp").value=cfg.temperature;document.getElementById("tempVal").textContent=cfg.temperature;
  document.getElementById("cfgTopP").value=cfg.top_p;document.getElementById("toppVal").textContent=cfg.top_p;
  document.getElementById("cfgCtx").value=cfg.contextRounds;document.getElementById("cfgNumCtx").value=cfg.num_ctx||8192;
  document.getElementById("cfgNumPredict").value=cfg.num_predict||1024;
  document.getElementById("cfgFontSize").value=cfg.fontSize||15;document.getElementById("fontSizeVal").textContent=cfg.fontSize||15;
  document.getElementById("cfgCompareConcurrent").checked = cfg.compareConcurrent || false;
  const accent=cfg.accent||"#4d6bfe";document.getElementById("cfgAccent").value=accent;
  document.querySelectorAll("#accentPicker .color-swatch").forEach(s=>s.classList.toggle("active",s.dataset.color.toLowerCase()===accent.toLowerCase()));
  renderTplList();renderEmoList();renderPresets();document.getElementById("settingsMask").classList.add("show");
}
function closeSettings(){document.getElementById("settingsMask").classList.remove("show")}
function saveSettings(){
  cfg.url=document.getElementById("cfgUrl").value.trim().replace(/\/$/,"")||DEFAULT_CFG.url;
  cfg.ragUrl=document.getElementById("cfgRagUrl").value.trim().replace(/\/$/,"")||DEFAULT_CFG.ragUrl;
  cfg.system=document.getElementById("cfgSys").value;
  cfg.temperature=parseFloat(document.getElementById("cfgTemp").value);cfg.top_p=parseFloat(document.getElementById("cfgTopP").value);
  cfg.contextRounds=parseInt(document.getElementById("cfgCtx").value)||20;cfg.num_ctx=parseInt(document.getElementById("cfgNumCtx").value)||8192;
  cfg.num_predict=parseInt(document.getElementById("cfgNumPredict").value)||1024;
  cfg.compareConcurrent = document.getElementById("cfgCompareConcurrent").checked;
  cfg.fontSize=parseInt(document.getElementById("cfgFontSize").value)||15;cfg.accent=document.getElementById("cfgAccent").value||"";
  saveLocal();applyFontSize();applyAccentColor();closeSettings();fetchModels();updateCtxInfo();
}

function renderPresets(){
  const list=document.getElementById("presetList");
  if(!presets.length){list.innerHTML='<div style="color:var(--text-dim);font-size:13px">还没有预设</div>';return}
  list.innerHTML=presets.map(p=>`<div class="preset-item"><span>${escapeHtml(p.name)}<span style="color:var(--text-dim);font-size:12px;margin-left:8px">(${p.prompt.length} 字)</span></span><span><button data-edit="${p.id}">编辑</button><button data-del="${p.id}">删除</button></span></div>`).join("");
  list.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>editPreset(b.dataset.edit));
  list.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{
    if(!confirm("删除？"))return;
    presets=presets.filter(x=>x.id!==b.dataset.del);if(currentPresetId===b.dataset.del)currentPresetId="";
    saveLocal();saveToDisk();renderPresets();
  });
}
function addPreset(){editingPresetId=null;document.getElementById("presetTitle").textContent="新建预设";document.getElementById("presetName").value="";document.getElementById("presetPrompt").value="";document.getElementById("presetMask").classList.add("show")}
function editPreset(id){const p=presets.find(x=>x.id===id);if(!p)return;editingPresetId=id;document.getElementById("presetTitle").textContent="编辑预设";document.getElementById("presetName").value=p.name;document.getElementById("presetPrompt").value=p.prompt;document.getElementById("presetMask").classList.add("show")}
function closePresetEdit(){document.getElementById("presetMask").classList.remove("show")}
function savePresetEdit(){const name=document.getElementById("presetName").value.trim();const prompt=document.getElementById("presetPrompt").value;if(!name){alert("请填写名称");return}if(editingPresetId){const p=presets.find(x=>x.id===editingPresetId);p.name=name;p.prompt=prompt;}else{presets.push({id:"p"+Date.now(),name,prompt});}saveLocal();saveToDisk();renderPresets();closePresetEdit();}
async function importPresetFolder(){
  try{
    const dir=await window.showDirectoryPicker({mode:"read"});
    const allFiles=[];
    for await(const entry of dir.values()){
      if(entry.kind==="file"){
        const nm=entry.name.toLowerCase();
        if(/\.(md|markdown|txt|text)$/i.test(nm)){const f=await entry.getFile();if(f.size>500*1024)continue;allFiles.push({name:entry.name,file:f})}
      }
    }
    if(!allFiles.length){alert("没有 .md / .txt 文件。");return}
    let chosen=allFiles.filter(x=>/^skill\.(md|markdown|txt)$/i.test(x.name));
    if(!chosen.length){
      const blacklist=/^(license|licence|changelog|contributing|security|code_of_conduct|code-of-conduct|gitignore|\.gitignore)/i;
      chosen=allFiles.filter(x=>!blacklist.test(x.name));
      chosen.sort((a,b)=>(/^readme/i.test(a.name)?1:0)-(/^readme/i.test(b.name)?1:0));
    }
    const used=chosen.slice(0,3);
    let combined="";
    for(const item of used){const txt=await item.file.text();if(used.length>1)combined+=`\n\n### 来自 ${item.name}\n${txt}`;else combined+=txt}
    const name=prompt("给这个预设起个名字：",dir.name);if(!name)return;
    presets.push({id:"p"+Date.now(),name,prompt:combined.trim()});
    saveLocal();saveToDisk();renderPresets();
    alert("导入成功！共读取 " + used.length + " 个文件：" + used.map(x=>"\n• "+x.name).join("") + "\n\n总字数：" + combined.length)
  }catch(e){if(e.name!=="AbortError")alert("失败："+e.message)}
}

function renderTplList(){
  const box=document.getElementById("tplList");if(!box)return;
  if(!cfg.quickPrompts.length){box.innerHTML='<div style="color:var(--text-dim);font-size:13px;padding:4px 0">还没有模板</div>';return;}
  box.innerHTML=cfg.quickPrompts.map((p,i)=>`<div class="tpl-row"><input type="text" class="tpl-input" data-idx="${i}" value="${escapeHtml(p)}" placeholder="模板文字"><button class="tpl-up" data-idx="${i}" title="上移" ${i===0?"disabled":""}>↑</button><button class="tpl-down" data-idx="${i}" title="下移" ${i===cfg.quickPrompts.length-1?"disabled":""}>↓</button><button class="tpl-del" data-idx="${i}" title="删除">🗑</button></div>`).join("");
  box.querySelectorAll(".tpl-input").forEach(inp=>{inp.oninput=()=>{const i=parseInt(inp.dataset.idx);cfg.quickPrompts[i]=inp.value;saveLocal();renderQuickPrompts();};});
  box.querySelectorAll(".tpl-up").forEach(b=>b.onclick=()=>moveTpl(parseInt(b.dataset.idx),-1));
  box.querySelectorAll(".tpl-down").forEach(b=>b.onclick=()=>moveTpl(parseInt(b.dataset.idx),1));
  box.querySelectorAll(".tpl-del").forEach(b=>b.onclick=()=>delTpl(parseInt(b.dataset.idx)));
}
function moveTpl(i,d){const j=i+d;if(j<0||j>=cfg.quickPrompts.length)return;[cfg.quickPrompts[i],cfg.quickPrompts[j]]=[cfg.quickPrompts[j],cfg.quickPrompts[i]];saveLocal();renderTplList();renderQuickPrompts();}
function delTpl(i){if(!confirm("删除这个模板？"))return;cfg.quickPrompts.splice(i,1);saveLocal();renderTplList();renderQuickPrompts();}
function addTpl(){cfg.quickPrompts.push("新模板");saveLocal();renderTplList();renderQuickPrompts();setTimeout(()=>{const inputs=document.querySelectorAll("#tplList .tpl-input");const last=inputs[inputs.length-1];if(last){last.focus();last.select()}},50);}
function resetTpl(){if(!confirm("恢复默认三个模板（翻译、总结、改代码）？"))return;cfg.quickPrompts=["翻译","总结","改代码"];saveLocal();renderTplList();renderQuickPrompts();}

function renderEmoList(){
  const box=document.getElementById("emoList");if(!box)return;
  const map=getEmoMap();const keys=Object.keys(map);
  if(!keys.length){box.innerHTML='<div style="color:var(--text-dim);font-size:13px;padding:4px 0">还没有颜文字，点下面新增一个</div>';return;}
  box.innerHTML=keys.map((k,i)=>`<div class="emo-row" data-i="${i}"><input type="text" class="emo-key" value="${escapeHtml(k)}" placeholder="标签" spellcheck="false"><input type="text" class="emo-val" value="${escapeHtml(map[k])}" placeholder="颜文字" spellcheck="false"><button class="del" title="删除">🗑</button></div>`).join("");
  box.querySelectorAll(".emo-row").forEach(row=>{
    const i=parseInt(row.dataset.i);const oldKey=keys[i];const keyInp=row.querySelector(".emo-key");const valInp=row.querySelector(".emo-val");
    const commit=(newKey,newVal)=>{const curMap=getEmoMap();if(oldKey!==newKey){delete curMap[oldKey];}curMap[newKey]=newVal;cfg.emoMap=curMap;saveLocal();renderEmoList();};
    keyInp.onchange=()=>{const raw=keyInp.value.trim();const nk=raw.replace(/[^a-zA-Z0-9_]/g,"");if(!nk){alert("标签只能用英文、数字、下划线");renderEmoList();return}if(nk!==raw)alert("标签只能用英文、数字、下划线，已自动过滤为："+nk);commit(nk,valInp.value);};
    valInp.oninput=()=>{const m=getEmoMap();m[oldKey]=valInp.value;cfg.emoMap=m;saveLocal();};
    row.querySelector(".del").onclick=()=>{if(!confirm(`删除标签 ${oldKey}？`))return;const m=getEmoMap();delete m[oldKey];cfg.emoMap=m;saveLocal();renderEmoList();renderMessages();};
  });
}
function addEmo(){const m=getEmoMap();let n=1,key="new";while(m[key]){n++;key="new"+n}m[key]="(・_・)";cfg.emoMap=m;saveLocal();renderEmoList();setTimeout(()=>{const rows=document.querySelectorAll("#emoList .emo-row");const last=rows[rows.length-1];if(last){const k=last.querySelector(".emo-key");k.focus();k.select()}},50);}
async function resetEmo(){
  if(!confirm("确定要从后端重新拉取颜文字库吗？（会覆盖你本地修改的）"))return;
  try {
    const emojiRes = await fetch(`${getRagUrl()}/api/emoji`);
    const emojiData = await emojiRes.json();
    if(emojiData.emoji && Object.keys(emojiData.emoji).length > 0) {cfg.emoMap = emojiData.emoji;dynamicEmo = emojiData.emoji;saveLocal();renderEmoList();renderMessages();alert("已从 Python 后端重新加载颜文字！");}
    else {alert("后端返回为空，请检查 emoji_config.json 文件是否存在。");}
  } catch(e) {alert("拉取失败，请确认 RAG 秘书（Python黑框）已启动。");}
}