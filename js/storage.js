// ============ 存储层 ============
// 草稿 + IndexedDB + 文件夹同步
//
// 薄壳：真正的实现已经搬进 js/persistence.js（持久化模块）。
// 这个文件现在只负责「浏览器 API 的形状」和「用户交互」，
// 不再决定写什么、写去哪、什么时候写、失败了怎么办。

function draftKey(){return currentSessionId||"__none__"}

// 草稿：高频（每次敲键）、可以放弃。
// 旧行为是静默吞异常，这里保持 —— 草稿写不进去不该打断打字。
function saveDraft(){
  const ta=document.getElementById("input");if(!ta)return;
  const v=ta.value;const k=draftKey();
  if(v&&v.trim())drafts[k]=v;else delete drafts[k];
  try{persistNow("drafts")}catch(e){}
}
function restoreDraft(){const ta=document.getElementById("input");if(!ta)return;ta.value=drafts[draftKey()]||"";autoResize(ta);}

function idb(){return new Promise((res,rej)=>{const r=indexedDB.open(PERSIST_DB.name,1);r.onupgradeneeded=()=>r.result.createObjectStore(PERSIST_DB.store);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function idbSet(k,v){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction(PERSIST_DB.store,"readwrite");tx.objectStore(PERSIST_DB.store).put(v,k);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
async function idbGet(k){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction(PERSIST_DB.store,"readonly");const rq=tx.objectStore(PERSIST_DB.store).get(k);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error)})}

// 权限检查委托给当前的文件夹后端（它有 handle，这里没有）
async function ensureFolderPermission(){
  const fb=getFolderBackend();
  if(!fb||!fb.ensurePermission)return false;
  try{return await fb.ensurePermission()}catch(e){return false}
}

// 薄壳：会话数据集交给持久化模块写进它唯一的家。
// 没绑文件夹时是空操作（与旧版第一行 if(!folderHandle) return 一致）。
async function saveToDisk(){
  persistConversationsShim();
}

// 薄壳：按单一真值源读会话数据集。返回是否读到了东西（旧签名要求布尔）。
async function loadFromDisk(){
  if(!folderHandle)return false;
  try{
    const r=await loadConversations();
    return r.source==="disk"||r.source==="migrated";
  }catch(e){return false}
}

// 绑定文件夹。按约定分三种情况：
//   · 文件不存在或为空 → 把当前数据搬进去
//   · 文件里已有数据   → 问一次：用文件夹里的替换，还是把当前的写进去
async function pickFolder(){
  try{
    const h=await window.showDirectoryPicker({mode:"readwrite",id:"chatDataDir"});
    folderHandle=h;cfg.dir=h.name;
    document.getElementById("cfgDir").value=h.name;
    await idbSet(PERSIST_DB.folderHandleKey,h);

    // 交接：从现在起会话数据集的唯一真值源是这个文件夹
    setFolderBackend(makeFolderBackend(h));

    const info=await inspectConversationFolder();
    persistNow("cfg");   // cfg.dir 变了，配置也得落下

    if(info.error){
      renderSessions();renderMessages();renderPresets();
      alert("已绑定："+h.name+"\n\n但无法读取这个文件夹里已有的数据：\n"+
            (info.error.message||info.error)+
            "\n\n在问题解决之前，程序不会往这个文件夹写入，以免覆盖里面原有的对话。");
      return;
    }

    if(info.hasData){
      const takeFolder=confirm(
        "这个文件夹里已经有 "+info.count+" 个对话。\n\n"+
        "【确定】用文件夹里的数据替换当前的（当前 "+sessions.length+" 个对话会被清掉）\n"+
        "【取消】保留当前对话，把它们写进这个文件夹（文件夹里原有的会被覆盖）"
      );
      if(takeFolder)await adoptFolderConversations();
      else await migrateIntoFolder();
    }else{
      // 空文件夹：把当前数据搬进去（最符合用户对「设置保存位置」的期望）
      await migrateIntoFolder();
    }

    persistNow("cfg");   // cfg.dir 变了，配置也得落下
    renderSessions();renderMessages();renderPresets();
    alert("已绑定："+h.name);
  }catch(e){if(e.name!=="AbortError")alert("失败："+e.message)}
}