// ============ Markdown 渲染 + 思考分离 + 颜文字 ============

function getEmoMap(){
  return (window.currentSkillEmo && typeof window.currentSkillEmo === "object") ? window.currentSkillEmo : {};
}

function replaceEmo(text){
  if(!text) return text;
  const map = getEmoMap();
  return text.replace(EMO_RE, (m, key) => (map[key] !== undefined ? map[key] : m));
}

function splitThinking(text){
  if(!text) return {thinking:"", content:""};
  if(/<think[\s>]/i.test(text)){
    const m = text.match(/<think[^>]*>([\s\S]*?)<\/think>([\s\S]*)/i);
    if(m) return {thinking:m[1].trim(), content:m[2].trim()};
    const m2 = text.match(/<think[^>]*>([\s\S]*)/i);
    if(m2) return {thinking:m2[1].trim(), content:""};
  }
  const mT = text.match(/^\s*Thinking\.\.\.\s*\n+([\s\S]*?)\n+\s*(?:…|\.\.\.)?\s*done thinking\.?\s*\n+([\s\S]*)$/i);
  if(mT) return {thinking:mT[1].trim(), content:mT[2].trim()};
  if(/^\s*Thinking\.\.\./i.test(text)) return {thinking:text.replace(/^\s*Thinking\.\.\.\s*\n?/,"").trim(), content:""};
  const mC = text.match(/^\s*\*{0,2}\s*[（(]\s*思考\s*[)）]\s*\*{0,2}\s*\n+/);
  if(mC){
    const after = text.slice(mC[0].length);
    const marks = ["步骤解析","解析：","解析:","答案：","答案:","最终答案","总结：","总结:","结论：","结论:","【答案】","Answer:","Solution:"];
    let splitAt = -1;
    for(const mk of marks){
      const re = new RegExp("\\n\\s*\\n\\s*" + mk.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
      const mm = after.match(re);
      if(mm && (splitAt < 0 || mm.index < splitAt)) splitAt = mm.index;
    }
    if(splitAt > 0) return {thinking:after.slice(0, splitAt).trim(), content:after.slice(splitAt).trim()};
    return {thinking:after.trim(), content:""};
  }
  return {thinking:"", content:text};
}

function getThinkAndContent(m){
  if(m.thinking && m.thinking.length > 0) return {thinking:m.thinking, content:m.content};
  return splitThinking(m.content);
}

function renderMarkdown(text){
  if(!text) return "";
  text = replaceEmo(text);
  let html;
  try{ html = marked.parse(text, {breaks:true, gfm:true}); }
  catch(e){ html = escapeHtml(text); }
  return DOMPurify.sanitize(html, {ADD_ATTR:["target"]});
}

function postRender(container){
  container.querySelectorAll("pre code").forEach(codeEl => {
    if(!codeEl.dataset.done){
      try{ hljs.highlightElement(codeEl); }catch(e){}
      codeEl.dataset.done = "1";
    }
    const pre = codeEl.parentElement;
    if(pre.parentElement && pre.parentElement.classList.contains("code-block")) return;
    const lang = (codeEl.className.match(/language-(\w+)/) || [])[1] || "text";
    const block = document.createElement("div");
    block.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    head.innerHTML = `<span>${lang}</span><button class="code-copy">复制</button>`;
    pre.parentNode.insertBefore(block, pre);
    block.appendChild(head);
    block.appendChild(pre);
    head.querySelector(".code-copy").onclick = () => {
      navigator.clipboard.writeText(codeEl.innerText).then(() => {
        const b = head.querySelector(".code-copy");
        b.textContent = "已复制 ✓";
        setTimeout(() => b.textContent = "复制", 1500);
      });
    };
  });
  try{
    renderMathInElement(container, {
      delimiters: [
        {left:"$$", right:"$$", display:true},
        {left:"\\[", right:"\\]", display:true},
        {left:"$", right:"$", display:false},
        {left:"\\(", right:"\\)", display:false}
      ],
      throwOnError: false
    });
  }catch(e){}
}