// ============ 上下文压缩 ============

async function compressContext(){
  if(generating){alert("生成中，请稍候");return}
  const s=getCurrentSession();
  if(!s||s.messages.length<6){alert("消息太少，无需压缩");return}
  const keepCount=6;
  const toSummarize=s.messages.slice(0,-keepCount);
  const toKeep=s.messages.slice(-keepCount);
  if(toSummarize.length<2){alert("可压缩的消息太少");return}
  if(!confirm(`将把前 ${toSummarize.length} 条消息压缩成一段摘要（用当前模型 ${cfg.model}），继续？`))return;
  const lines=[];
  for(const m of toSummarize){
    if(m.isSummary){lines.push("【之前摘要】"+m.content);continue}
    if(m.compare){lines.push("【AI】"+m.compare.map(c=>c.content).join("\n---\n"));continue}
    if(m.role==="user")lines.push("【用户】"+m.content);
    else if(m.role==="assistant")lines.push("【AI】"+m.content);
  }
  const prompt="请把下面这段对话总结成简洁的要点，保留关键信息、结论、用户偏好和未解决的问题。只输出总结本身，不要寒暄，不要加代码块围栏。\n\n"+lines.join("\n\n");
  generating=true;updateSendBtn();abortCtrl=new AbortController();
  setStatus("正在生成摘要…");
  let summary="";
  await streamRequest(cfg.model,[{role:"system",content:"你是对话总结助手，输出简洁要点。"},{role:"user",content:prompt}],(msg)=>{if(msg.content)summary+=msg.content},()=>{},(e,aborted)=>{if(!aborted)summary="";},abortCtrl.signal);
  generating=false;abortCtrl=null;updateSendBtn();
  if(!summary.trim()){setStatus("压缩失败",true);return}
  s.messages=[{role:"assistant",isSummary:true,content:summary.trim(),time:Date.now(),model:cfg.model},...toKeep];
  s.updatedAt=Date.now();
  saveLocal();saveToDisk();renderMessages();updateCtxInfo();
  setStatus("已压缩");
}