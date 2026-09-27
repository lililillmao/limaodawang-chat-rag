// ============ 输入区 + 快捷模板 + 语音 + 快捷键 ============

function updateSendBtn(){const b=document.getElementById("sendBtn");if(generating){b.textContent="■ 停止";b.classList.add("stop")}else{b.textContent="发送";b.classList.remove("stop")}}
function autoResize(ta){ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,220)+"px"}

function renderQuickPrompts(){
  const box=document.getElementById("quickPrompts");if(!box)return;
  if(!cfg.quickPrompts||!cfg.quickPrompts.length){box.innerHTML="";return}
  box.innerHTML=cfg.quickPrompts.map((p,i)=>`<button class="quick-btn" data-idx="${i}">${escapeHtml(p)}</button>`).join("");
  box.querySelectorAll(".quick-btn").forEach(btn=>{
    btn.onmousedown=()=>{
      // 点击前捕获选区，防止焦点转移后丢失
      const sel=window.getSelection();
      const t=sel?sel.toString():"";
      if(t)cachedSelection=t;
    };
    btn.onclick=async()=>{
      const input=document.getElementById("input");
      const idx=parseInt(btn.dataset.idx);
      const raw=cfg.quickPrompts[idx]||btn.textContent||"";
      const prompt=await resolveTemplateVars(raw);

      // 兼容旧行为：翻译 / 总结 / 改代码
      if(raw==="翻译")input.value=input.value?`请将以下内容翻译成中文：\n\n${input.value}`:"请将以下内容翻译成中文：\n\n";
      else if(raw==="总结")input.value=input.value?`请总结以下内容：\n\n${input.value}`:"请总结以下内容：\n\n";
      else if(raw==="改代码")input.value=input.value?`请优化以下代码：\n\n${input.value}`:"请优化以下代码：\n\n";
      else input.value=input.value?`${prompt}\n\n${input.value}`:prompt+"\n\n";

      autoResize(input);saveDraft();input.focus();
    };
  });
}

function bindKeyboardShortcuts(){
  document.addEventListener("keydown",e=>{
    if(e.ctrlKey&&e.key.toLowerCase()==="n"){e.preventDefault();if(generating){alert("生成中");return}createSession();renderMessages();return}
    if(e.ctrlKey&&e.key.toLowerCase()==="k"){e.preventDefault();const inp=document.getElementById("input");inp.value="";autoResize(inp);saveDraft();inp.focus();return}
    if(e.ctrlKey&&e.key===","){e.preventDefault();openSettings();return}
    if(e.key==="Escape"){
      if(document.getElementById("regenModelMask").classList.contains("show")){closeRegenModelModal();return}
      if(quoteState){clearQuote();return}
      if(editingMsgIndex>=0){cancelEdit();return}
      if(generating&&abortCtrl)abortCtrl.abort();
    }
  });
}

function toggleVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("你的浏览器不支持语音识别。请用 Chrome 或 Edge 打开。");return}
  const btn=document.getElementById("micBtn");
  if(voiceRec){try{voiceRec.stop()}catch(e){}voiceRec=null;btn.classList.remove("recording");return}
  voiceRec=new SR();voiceRec.lang="zh-CN";voiceRec.continuous=true;voiceRec.interimResults=true;
  const input=document.getElementById("input");let baseText=input.value;
  voiceRec.onresult=(e)=>{let final="",interim="";for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)final+=e.results[i][0].transcript;else interim+=e.results[i][0].transcript;}if(final)baseText+=final;input.value=baseText+interim;autoResize(input);saveDraft();};
  voiceRec.onerror=(e)=>{if(e.error==="not-allowed")alert("麦克风权限被拒绝。请在浏览器地址栏左侧点🔒图标允许麦克风访问。");voiceRec=null;btn.classList.remove("recording");};
  voiceRec.onend=()=>{voiceRec=null;btn.classList.remove("recording")};
  try{voiceRec.start();btn.classList.add("recording")}catch(e){alert("启动失败："+e.message);voiceRec=null}
}

function updateRagBadge(){
  const badge=document.getElementById("ragBadge");const btn=document.getElementById("ragBtn");if(!badge||!btn)return;
  if(cfg.ragEnabled){badge.textContent="开";btn.classList.add("on");}else{badge.textContent="关";btn.classList.remove("on");}
}