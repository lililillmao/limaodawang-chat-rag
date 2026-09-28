// ============ 存储层 ============
// 草稿 + IndexedDB + 文件夹同步

function draftKey(){return currentSessionId||"__none__"}
function saveDraft(){const ta=document.getElementById("input");if(!ta)return;const v=ta.value;const k=draftKey();if(v&&v.trim())drafts[k]=v;else delete drafts[k];try{localStorage.setItem(LS.drafts,JSON.stringify(drafts))}catch(e){}}
function restoreDraft(){const ta=document.getElementById("input");if(!ta)return;ta.value=drafts[draftKey()]||"";autoResize(ta);}

function idb(){return new Promise((res,rej)=>{const r=indexedDB.open("chat_db",1);r.onupgradeneeded=()=>r.result.createObjectStore("kv");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function idbSet(k,v){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(v,k);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
async function idbGet(k){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction("kv","readonly");const rq=tx.objectStore("kv").get(k);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error)})}
async function ensureFolderPermission(){if(!folderHandle)return false;const opts={mode:"readwrite"};if(await folderHandle.queryPermission(opts)==="granted")return true;if(await folderHandle.requestPermission(opts)==="granted")return true;return false}
async function saveToDisk(){if(!folderHandle)return;try{if(!(await ensureFolderPermission()))return;const f=await folderHandle.getFileHandle("conversations.json",{create:true});const w=await f.createWritable();await w.write(JSON.stringify({sessions,presets,savedAt:new Date().toISOString()},null,2));await w.close()}catch(e){}}
async function loadFromDisk(){if(!folderHandle)return false;try{if(!(await ensureFolderPermission()))return false;const f=await folderHandle.getFileHandle("conversations.json");const file=await f.getFile();const data=JSON.parse(await file.text());if(Array.isArray(data.sessions))sessions=data.sessions;if(Array.isArray(data.presets))presets=data.presets;return true}catch(e){return false}}

async function pickFolder(){try{const h=await window.showDirectoryPicker({mode:"readwrite",id:"chatDataDir"});folderHandle=h;cfg.dir=h.name;document.getElementById("cfgDir").value=h.name;await idbSet("folderHandle",h);saveLocal();const loaded=await loadFromDisk();if(loaded){renderSessions();renderMessages();renderPresets()}await saveToDisk();alert("已绑定："+h.name)}catch(e){if(e.name!=="AbortError")alert("失败："+e.message)}}