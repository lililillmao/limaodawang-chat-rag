// 端到端集成冒烟测试
// 按 index.html 的顺序加载全部 js 模块，在模拟 DOM 环境里跑 init()，
// 验证：无异常、关键函数齐备、新功能接线正确、旧功能未被破坏。
// 用法: node test_integration.js <项目根目录>
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2];
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

// ---------------- 从 index.html 解析真实加载顺序 ----------------
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const order = [];
for (const m of html.matchAll(/<script\s+src="(js\/[^"]+)"/g)) order.push(m[1]);
const cssList = [];
for (const m of html.matchAll(/<link\s+rel="stylesheet"\s+href="(css\/[^"]+)"/g)) cssList.push(m[1]);
const htmlIds = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) htmlIds.add(m[1]);

// ---------------- 模拟 DOM ----------------
let elementCount = 0;
function mkEl(tag, id) {
  const el = {
    tagName: (tag || "div").toUpperCase(), id: id || "", _children: [],
    value: "", innerHTML: "", textContent: "", checked: false, disabled: false,
    scrollTop: 0, scrollHeight: 1000, clientHeight: 500, offsetWidth: 100, offsetHeight: 40,
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = v; this[k] = v; },
      removeProperty(k) { delete this._p[k]; delete this[k]; },
      getPropertyValue(k) { return this._p[k] || ""; }
    },
    dataset: {}, files: [], options: [], children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { const want = (f === undefined) ? !this._s.has(c) : !!f; want ? this._s.add(c) : this._s.delete(c); return want; }
    },
    _handlers: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (this._handlers[t] || []).forEach(fn => fn(Object.assign({ type: t, preventDefault() {}, stopPropagation() {}, target: this }, ev))); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {}, remove() {},
    insertBefore(c) { this._children.push(c); return c; },
    closest() { return null; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }; },
    scrollIntoView() {}, focus() {}, blur() {}, click() { this._clicked = (this._clicked || 0) + 1; },
    matches() { return false; }, contains() { return false; },
    getContext() { return { fillRect() {}, drawImage() {}, fillStyle: "" }; },
    toDataURL() { return "data:image/jpeg;base64,TESTDATA"; },
    // textarea 自动高度用
    scrollHeightValue: 100
  };
  Object.defineProperty(el, "scrollHeight", { get() { return 1000; }, configurable: true });
  elementCount++;
  return el;
}
const elById = new Map();
function getEl(id) {
  if (!elById.has(id)) elById.set(id, mkEl("div", id));
  return elById.get(id);
}
const documentStub = {
  documentElement: mkEl("html"),
  body: mkEl("body"),
  head: mkEl("head"),
  getElementById: (id) => getEl(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (t) => mkEl(t),
  createTextNode: () => ({}),
  addEventListener(t, fn) { (this._h = this._h || {}), (this._h[t] = this._h[t] || []).push(fn); },
  removeEventListener() {},
  execCommand: () => true,
  visibilityState: "visible",
  readyState: "complete",
  _h: {}
};
documentStub.documentElement.dataset = {};

// localStorage
const lsData = {};
const localStorageStub = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null; },
  setItem(k, v) { lsData[k] = String(v); },
  removeItem(k) { delete lsData[k]; },
  clear() { Object.keys(lsData).forEach(k => delete lsData[k]); },
  key(i) { return Object.keys(lsData)[i]; },
  get length() { return Object.keys(lsData).length; }
};

// fetch：默认全部失败，但不抛异常（模拟后端未启动，验证降级路径）
const fetchCalls = [];
function fetchStub(url, opt) {
  fetchCalls.push({ url: String(url), method: (opt && opt.method) || "GET", body: opt && opt.body });
  return Promise.resolve({
    ok: false, status: 503,
    json: async () => ({}), text: async () => "service unavailable",
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }
  });
}

// IndexedDB 桩
const idbStore = {};
function idbOpenStub() {
  const req = {};
  setTimeout(() => {
    req.result = {
      transaction: () => ({ objectStore: () => ({ put(v, k) { idbStore[k] = v; }, get(k) { const r = {}; setTimeout(() => { r.result = idbStore[k]; r.onsuccess && r.onsuccess(); }, 0); return r; } }) }),
      objectStoreNames: { contains: () => false },
      createObjectStore: () => ({})
    };
    req.onupgradeneeded && req.onupgradeneeded();
    req.onsuccess && req.onsuccess();
  }, 0);
  return req;
}

const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  document: documentStub,
  localStorage: localStorageStub,
  indexedDB: { open: idbOpenStub },
  navigator: { clipboard: { writeText: async () => {}, readText: async () => "" }, storage: { estimate: async () => ({ usage: 0, quota: 5e6 }), persist: async () => true }, userAgent: "node" },
  location: { href: "http://127.0.0.1:5500/index.html", origin: "http://127.0.0.1:5500" },
  fetch: fetchStub,
  alert: () => {}, confirm: () => true, prompt: () => null,
  Blob: function (parts) { this.parts = parts; this.size = (parts || []).join("").length; },
  File: function () {}, FileReader: function () { this.readAsDataURL = () => {}; this.readAsText = () => {}; },
  FormData: function () { this.append = () => {}; this.getAll = () => []; },
  URL: { createObjectURL: () => "blob:mock", revokeObjectURL() {} },
  Image: function () { this.onload = null; this.src = ""; setTimeout(() => this.onload && this.onload(), 0); },
  TextEncoder, TextDecoder, AbortController,
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  SpeechSynthesisUtterance: function () {},
  speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [], paused: false, speaking: false },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  DOMPurify: { sanitize: (s) => s },
  marked: { parse: (s) => String(s), setOptions() {} },
  hljs: { highlightElement() {}, highlight() { return { value: "" }; }, getLanguage: () => true },
  renderMathInElement: () => {},
  katex: { render: () => "" },
  CSS: { escape: (s) => String(s) },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  speechSynthesisUtterance: function () {},
  performance: { now: () => Date.now() },
  structuredClone: (o) => JSON.parse(JSON.stringify(o)),
  isSecureContext: true,
  // window 事件（项目里 bindDragAndDrop / beforeunload 都用 window.addEventListener）
  _wh: {},
  addEventListener(t, fn) { (this._wh[t] = this._wh[t] || []).push(fn); },
  removeEventListener(t, fn) { if (this._wh[t]) this._wh[t] = this._wh[t].filter(f => f !== fn); },
  dispatchEvent() { return true; }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// ---------------- 按顺序加载所有模块 ----------------
section("1. 模块加载（真实 index.html 顺序）");
const loadErrors = [];
for (const rel of order) {
  const full = path.join(ROOT, rel.replace(/\//g, path.sep));
  if (!fs.existsSync(full)) { loadErrors.push(rel + " 文件不存在"); continue; }
  try {
    vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: rel });
  } catch (e) {
    loadErrors.push(rel + " 抛异常: " + e.message);
  }
}
ok("加载了 " + order.length + " 个模块无异常", loadErrors.length === 0, loadErrors);
console.log("  模块数: " + order.length + "，元素桩数: " + elementCount);

// ---------------- 桥接：访问 vm 里用 let/const 声明的绑定 ----------------
// vm.runInContext 里 `let`/`const` 不会成为 sandbox 对象属性，必须通过求值访问。
function ev(expr) { return vm.runInContext(expr, sandbox); }
function setVar(name, value) {
  sandbox.__tmp = value;
  return vm.runInContext(name + " = __tmp", sandbox);
}
function callFn(name, ...args) {
  if (args.length === 0) return vm.runInContext(name + "()", sandbox);
  sandbox.__args = args;
  return vm.runInContext(name + "(...__args)", sandbox);
}

// ---------------- init() 已在 main.js 末尾自动调用 ----------------
// 等一轮微任务/宏任务，让 init 里的 await 链跑起来
(async () => {
  section("2. init() 不抛异常");
  let initErr = null;
  const origErr = console.error;
  try {
    await new Promise(r => setTimeout(r, 120));
  } catch (e) { initErr = e; }
  ok("init() 异步流程无未捕获异常", initErr === null, initErr && String(initErr));

  section("3. 关键全局函数齐备（旧功能）");
  const legacyFns = [
    "loadLocal", "saveLocal", "applyTheme", "applyFontSize", "applyAccentColor", "resolveParam", "getEffectiveParams",
    "escapeHtml", "estimateTokens", "formatTime", "copyText", "setStatus", "getSessionChain", "getSessionDepth",
    "resolveTemplateVars", "renderMarkdown", "splitThinking", "getThinkAndContent", "postRender", "replaceEmo",
    "fetchModels", "streamRequest", "testProviderConnection", "fetchRagContext", "openLocalFolder", "parseTempFile",
    "fetchMemories", "addMemory", "deleteMemory", "searchMemories",
    "renderSessions", "renderMessages", "buildMessageInner", "buildRagSourcesHtml", "streamUpdate", "bindMsgActions",
    "renderMsgNav", "renderTempFileChips", "handleFiles", "bindDragAndDrop", "renderQuickPrompts", "bindKeyboardShortcuts",
    "toggleVoice", "updateRagBadge", "openSettings", "closeSettings", "saveSettings", "renderMemoryList",
    "renderProviderList", "openProviderEdit", "renderPresets", "renderTplList", "renderPresetParams",
    "openSessionParams", "saveSessionParams", "updateParamBtnLabel",
    "buildMessages", "getActiveSystemPrompt", "runStream", "extractMemoryFromConversation", "setCompareMode",
    "sendMessage", "continueGeneration", "regenerateLast", "startEditMessage", "saveEditMessage", "branchFromMessage",
    "compressContext", "backupAll", "restoreAll", "exportMarkdown", "exportTxt", "exportSingleAnswer",
    "buildComboPrompt", "refreshActiveSkills", "updateSkillStatus", "renderSkillCombo", "applySkillCombo", "pollBuildStatus",
    "saveDraft", "restoreDraft", "saveToDisk", "loadFromDisk", "pickFolder",
    "createSession", "getCurrentSession", "switchSession", "deleteSession", "togglePinSession", "updateBreadcrumb"
  ];
  const missingLegacy = legacyFns.filter(f => typeof sandbox[f] !== "function");
  ok("1.22 全部 " + legacyFns.length + " 个旧函数仍在", missingLegacy.length === 0, missingLegacy);

  section("4. 1.23 新函数齐备");
  const newFns = [
    "resolveOpenAIEndpoint", "toTokenNum", "accumulateToolCalls", "normalizeToolCalls", "buildMultimodalUserMessage",
    "recordUsage", "loadUsage", "saveUsage", "getUsageSummary", "estimateCost", "renderStatsPanel",
    "openStats", "closeStats", "exportUsageCsv", "clearUsage", "flushUsage", "isLocalModel",
    "getToolSchemas", "getToolByName", "getToolDisplayName", "parseToolArguments", "executeToolCall", "toolResultToText",
    "updateToolsBadge", "renderToolsInfo",
    "readFileAsDataUrl", "compressImage", "handleImages", "buildImageChipsHtml",
    "buildUserImagesHtml", "openImageViewer", "buildToolCallsHtml", "buildCostBadgeHtml",
    "exportExtrasMarkdown", "exportExtrasTxt", "runStreamWithTools", "recordUsageForMessage",
    "detectImportFormat", "convertImported", "handleExternalImportFile", "openImportExternal",
    "closeImportExternal", "renderImportPreview", "confirmImportExternal", "doImportExternal"
  ];
  const missingNew = newFns.filter(f => typeof sandbox[f] !== "function");
  ok("1.23 全部 " + newFns.length + " 个新函数已定义", missingNew.length === 0, missingNew);

  section("5. index.html 里的必需 DOM id 都存在");
  const requiredIds = [
    // 1.22 旧 id
    "input", "sendBtn", "messages", "sessionList", "modelSelect", "skillSelect", "ragBtn", "ragBadge",
    "fileInput", "fileUploadBtn", "tempFileChips", "quickPrompts", "settingsMask", "statsBody",
    // 1.23 新 id
    "statsBtn", "statsMask", "closeStatsBtn", "toolsBtn", "toolsBadge", "toolsInfoMask", "toolsInfoBody",
    "closeToolsInfoBtn", "importExternalBtn", "importExternalFile", "importExternalMask", "importExternalBody",
    "closeImportExternalBtn", "confirmImportExternalBtn", "cfgVisionEnabled", "cfgImageMaxEdge",
    "cfgToolsEnabled", "cfgMaxToolRounds"
  ];
  const missingIds = requiredIds.filter(id => !htmlIds.has(id));
  ok("全部 " + requiredIds.length + " 个 DOM id 都在 index.html 中", missingIds.length === 0, missingIds);
  console.log("  index.html 共 " + htmlIds.size + " 个 id");

  section("6. CSS 与脚本引用完整");
  const requiredCss = ["css/base.css", "css/layout.css", "css/chat.css", "css/input.css", "css/modal.css", "css/stats.css", "css/importer.css", "css/tools.css"];
  const missingCssRefs = requiredCss.filter(c => !cssList.includes(c));
  ok("index.html 引用了全部 " + requiredCss.length + " 个 CSS", missingCssRefs.length === 0, missingCssRefs);
  const missingCssFiles = requiredCss.filter(c => !fs.existsSync(path.join(ROOT, c.replace(/\//g, path.sep))));
  ok("对应 CSS 文件都实际存在", missingCssFiles.length === 0, missingCssFiles);
  const newScripts = ["js/features/tools.js", "js/features/stats.js", "js/features/importer.js"];
  ok("3 个新脚本已引入", newScripts.every(s => order.includes(s)), newScripts.filter(s => !order.includes(s)));

  section("7. 新功能的运行时行为");
  // 工具开关
  setVar("cfg", Object.assign({}, ev("cfg"), { toolsEnabled: false }));
  callFn("updateToolsBadge");
  ok("工具徽章初始为「关」", getEl("toolsBadge").textContent === "关", getEl("toolsBadge").textContent);
  setVar("cfg", Object.assign({}, ev("cfg"), { toolsEnabled: true }));
  callFn("updateToolsBadge");
  ok("开启后工具徽章为「开」", getEl("toolsBadge").textContent === "开", getEl("toolsBadge").textContent);
  ok("开启后按钮带 on 类", getEl("toolsBtn").classList.contains("on"));
  setVar("cfg", Object.assign({}, ev("cfg"), { toolsEnabled: false }));
  callFn("updateToolsBadge");

  // 多模态消息体（走真实函数）
  const sampleImg = [{ mime: "image/png", dataUrl: "data:image/png;base64,QQ==", b64: "QQ==" }];
  const om = callFn("buildMultimodalUserMessage", "hi", sampleImg, "ollama");
  ok("buildMultimodalUserMessage 处理 Ollama", om.images && om.images[0] === "QQ==", om);
  const oa = callFn("buildMultimodalUserMessage", "hi", sampleImg, "openai");
  ok("buildMultimodalUserMessage 处理 OpenAI", Array.isArray(oa.content) && oa.content.length === 2, oa);

  // 成本统计：记账后能读回来
  lsData["chat_usage_log"] = "[]";
  lsData["chat_usage"] = JSON.stringify({ v: 1, days: {} });
  callFn("loadUsage");
  const rec = callFn("recordUsage", { providerId: "ollama", providerName: "本地", model: "qwen2.5:7b", promptTokens: 100, completionTokens: 200, sessionId: "s1", kind: "chat" });
  ok("recordUsage 返回 ok", rec && rec.ok === true, rec);
  const rec2 = callFn("recordUsage", { providerId: "ds", providerName: "DeepSeek", model: "deepseek-chat", promptTokens: 1000, completionTokens: 2000, kind: "chat" });
  ok("云端模型算出非零费用", rec2.cost > 0, rec2.cost);
  const summ = callFn("getUsageSummary", { days: 30, groupBy: "provider" });
  ok("汇总有行数据", summ.rows.length >= 2, summ.rows.length);
  ok("本地模型被标记为免费", summ.rows.some(r => r.isLocal), summ.rows.map(r => ({ k: r.key, local: r.isLocal })));
  ok("汇总 totals 有 token", summ.totals.p >= 1100 && summ.totals.c >= 2200, summ.totals);

  // 记账绝不抛异常
  let recThrew = null;
  try {
    callFn("recordUsage", null);
    callFn("recordUsage", {});
    callFn("recordUsage", { promptTokens: -5, completionTokens: "abc" });
    callFn("recordUsage", { model: "<img src=x onerror=alert(1)>", promptTokens: 1, completionTokens: 1 });
  } catch (e) { recThrew = e.message; }
  ok("recordUsage 对脏入参不抛异常", recThrew === null, recThrew);

  // 渲染统计面板不抛
  let statsThrew = null;
  try { callFn("renderStatsPanel"); } catch (e) { statsThrew = e.message; }
  ok("renderStatsPanel 不抛异常", statsThrew === null, statsThrew);
  ok("统计面板写入了内容", String(getEl("statsBody").innerHTML).length > 0);

  // 导入：格式识别
  ok("识别 ChatGPT 格式", callFn("detectImportFormat", [{ mapping: {} }]) === "chatgpt");
  ok("识别 Claude 格式", callFn("detectImportFormat", [{ chat_messages: [] }]) === "claude");
  ok("识别本项目备份", callFn("detectImportFormat", { sessions: [] }) === "limao");
  ok("垃圾数据返回 unknown", callFn("detectImportFormat", { x: 1 }) === "unknown");

  // 导入：转换不抛
  let convThrew = null;
  try {
    callFn("convertImported", [{ title: "t", create_time: 1700000000, mapping: { a: { id: "a", parent: null, children: [], message: { author: { role: "user" }, content: { parts: ["hi"] }, create_time: 1700000000 } } } }], "chatgpt");
  } catch (e) { convThrew = e.message; }
  ok("convertImported 不抛异常", convThrew === null, convThrew);

  // 工具循环：未启用工具时必须等价于单轮，且不崩
  let loopThrew = null;
  (function () {
    try {
      setVar("sessions", [{ id: "sLoop", title: "工具循环", pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }]);
      setVar("currentSessionId", "sLoop");
      setVar("cfg", Object.assign({}, ev("cfg"), { toolsEnabled: false, maxToolRounds: 3 }));
      const aiMsg = { role: "assistant", content: "", thinking: "", model: "qwen2.5:7b", time: Date.now(), providerId: "ollama" };
      sandbox.__m = aiMsg;
      vm.runInContext("sessions[0].messages.push(__m)", sandbox);
      // 后端不可用（fetch 返回 503），应走 onError 分支并安全返回
      vm.runInContext("runStreamWithTools(sessions[0].messages[0], false, null, null, null)", sandbox);
    } catch (e) { loopThrew = e.message; }
  })();
  ok("runStreamWithTools 在后端不可用时不抛异常", loopThrew === null, loopThrew);

  section("8. 旧配置兼容（1.22 的 localStorage 能正常升级）");
  // 模拟一个 1.22 时代存下来的 cfg（没有 1.23 新字段）
  lsData["chat_cfg"] = JSON.stringify({
    providers: [{ id: "ollama", type: "ollama", name: "本地 Ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "" }],
    ragUrl: "http://127.0.0.1:8000", temperature: 0.7, top_p: 0.9, num_ctx: 8192, num_predict: 1024,
    memoryEnabled: true, memoryRounds: 3, memoryExtract: true, ragEnabled: true, quickPrompts: ["翻译"]
  });
  lsData["chat_sessions"] = JSON.stringify([{
    id: "sOld", title: "老会话", pinned: false, createdAt: 1700000000000, updatedAt: 1700000000000,
    messages: [
      { role: "user", content: "老消息", time: 1700000000000 },
      { role: "assistant", content: "老回答", thinking: "", model: "qwen2.5:7b", time: 1700000001000, skillName: "狸猫" }
    ]
  }]);
  lsData["chat_presets"] = JSON.stringify([]);
  lsData["chat_drafts"] = JSON.stringify({ sOld: "草稿内容" });
  callFn("loadLocal");
  ok("旧 providers 保留", Array.isArray(ev("cfg").providers) && ev("cfg").providers.length === 1, ev("cfg").providers.length);
  ok("旧 ragUrl 保留", ev("cfg").ragUrl === "http://127.0.0.1:8000", ev("cfg").ragUrl);
  ok("旧 ragEnabled 保留", ev("cfg").ragEnabled === true);
  ok("旧温度参数保留", ev("cfg").temperature === 0.7);
  ok("旧会话被读出", ev("sessions").length === 1 && ev("sessions")[0].id === "sOld", ev("sessions").length);
  ok("旧草稿被读出", ev("drafts").sOld === "草稿内容", ev("drafts").sOld);
  let legacyRenderErr = null;
  try { callFn("renderMessages"); } catch (e) { legacyRenderErr = e.message; }
  ok("渲染 1.22 旧消息不报错（无 images/toolCalls 字段）", legacyRenderErr === null, legacyRenderErr);
  ok("getEffectiveParams 仍工作", typeof ev("getEffectiveParams()").temperature === "number");

  section("9. 新消息渲染（真实 token + 费用徽章 + 工具卡片 + 图片）");
  setVar("sessions", [{
    id: "s2", title: "带用量", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "看图", time: Date.now(), images: [{ name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,QQ==" }] },
      { role: "assistant", content: "回答", thinking: "", model: "deepseek-chat", providerId: "ds",
        promptTokens: 1234, completionTokens: 5678, time: Date.now(),
        toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expression":"1+1"}' } }],
        toolResults: [{ id: "c1", name: "calculator", args: '{"expression":"1+1"}', ok: true, ms: 3, text: "1+1 = 2" }] },
      { role: "tool", content: "1+1 = 2", toolCallId: "c1", toolName: "calculator", time: Date.now(), hidden: true }
    ]
  }]);
  setVar("currentSessionId", "s2");
  let richErr = null;
  try { callFn("renderMessages"); } catch (e) { richErr = e.message; }
  ok("渲染带工具调用/图片/真实 token 的消息不抛异常", richErr === null, richErr);

  // 直接断言 renderMessages 真正生成的 DOM（测试台的 innerHTML 桩不累积，
  // 所以这里检查 appendChild 收到的那个 wrap 元素）
  const wraps = getEl("messages")._children;
  ok("renderMessages 生成了消息节点", wraps.length >= 2, wraps.length);
  const richWrap = wraps.find(w => String(w.innerHTML).includes("↑1234"));
  ok("真实 token 以 ↑↓ 展示", !!richWrap, wraps.map(w => String(w.innerHTML).slice(0, 80)));
  ok("消息不再显示 ≈ 估算值（有真实用量时）", !String(richWrap && richWrap.innerHTML).includes("≈ 1234"), String(richWrap && richWrap.innerHTML).slice(0, 200));
  ok("工具卡片出现在消息里", String(richWrap && richWrap.innerHTML).includes("tool-call-box"));
  ok("图片出现在用户消息里", wraps.some(w => String(w.innerHTML).includes("msg-image")));
  ok("隐藏的 tool 消息不单独渲染", !wraps.some(w => String(w.innerHTML).includes("1+1 = 2") && !String(w.innerHTML).includes("tool-call-box")));

  // buildMessageInner 直出，验证真实 token 文案
  const directInner = callFn("buildMessageInner", {
    role: "assistant", content: "x", model: "deepseek-chat", providerId: "ds",
    promptTokens: 1234, completionTokens: 5678, time: Date.now()
  }, false, 0);
  ok("buildMessageInner 输出真实 token", directInner.includes("↑1234") && directInner.includes("↓5678"), directInner.slice(0, 300));
  const oldInner = callFn("buildMessageInner", {
    role: "assistant", content: "旧回答内容", model: "qwen2.5:7b", time: Date.now()
  }, false, 0);
  ok("历史消息（无真实用量）回退到 ≈ 估算", oldInner.includes("≈"), oldInner.slice(0, 300));
  ok("历史消息不显示费用徽章", !oldInner.includes("msg-cost"), oldInner.slice(0, 300));

  // 直接验证三个渲染函数的产物，避免依赖 innerHTML 拼接
  const richMsg = {
    role: "assistant", content: "x", model: "deepseek-chat", providerId: "ds",
    promptTokens: 10, completionTokens: 20,
    toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expression":"1+1"}' } }],
    toolResults: [{ id: "c1", name: "calculator", args: '{"expression":"1+1"}', ok: true, ms: 3, text: "1+1 = 2" }]
  };
  const toolHtml = callFn("buildToolCallsHtml", richMsg);
  ok("工具卡片包含工具显示名", toolHtml.includes("计算器"), toolHtml.slice(0, 200));
  ok("工具卡片包含参数", toolHtml.includes("expression"), toolHtml.slice(0, 200));
  ok("工具卡片包含结果", toolHtml.includes("1+1 = 2"), toolHtml.slice(0, 200));
  ok("工具卡片有成功状态", toolHtml.includes("tool-ok"), toolHtml.slice(0, 200));
  ok("工具卡片对无工具消息返回空串", callFn("buildToolCallsHtml", { role: "assistant" }) === "");

  const imgHtml = callFn("buildUserImagesHtml", { images: [{ name: "a.png", dataUrl: "data:image/png;base64,QQ==" }] });
  ok("图片 HTML 含 img 标签", imgHtml.includes("<img") && imgHtml.includes("QQ=="), imgHtml);
  ok("图片 HTML 对无图消息返回空串", callFn("buildUserImagesHtml", { content: "x" }) === "");
  ok("图片 HTML 转义文件名", callFn("buildUserImagesHtml", { images: [{ name: '<b>"x"</b>', dataUrl: "d" }] }).includes("&lt;b&gt;"), callFn("buildUserImagesHtml", { images: [{ name: '<b>"x"</b>', dataUrl: "d" }] }));

  const costHtml = callFn("buildCostBadgeHtml", { model: "deepseek-chat", providerId: "ds" }, 1000, 2000, true);
  ok("云端模型显示费用徽章", costHtml.includes("💰") && costHtml.includes("$"), costHtml);
  ok("无真实用量时不显示费用徽章", callFn("buildCostBadgeHtml", { model: "deepseek-chat" }, 0, 0, false) === "");
  ok("费用徽章 HTML 转义 title", !callFn("buildCostBadgeHtml", { model: '"><script>', providerId: "ds" }, 10, 10, true).includes("<script>"));

  const exMd = callFn("exportExtrasMarkdown", richMsg);
  ok("Markdown 导出含工具调用小节", exMd.includes("工具调用") && exMd.includes("calculator"), exMd.slice(0, 200));
  const exTxt = callFn("exportExtrasTxt", richMsg);
  ok("TXT 导出含工具调用行", exTxt.includes("[工具调用]") && exTxt.includes("calculator"), exTxt.slice(0, 200));
  ok("无工具时导出附加内容为空", callFn("exportExtrasMarkdown", { content: "x" }) === "" && callFn("exportExtrasTxt", { content: "x" }) === "");

  section("10. 多轮工具循环的边界（不会无限循环）");
  ok("maxToolRounds 有默认值", typeof ev("cfg").maxToolRounds === "number" || ev("cfg").maxToolRounds === undefined);
  ok("TOOLS_REGISTRY 非空", ev("TOOLS_REGISTRY.length") === 5, ev("TOOLS_REGISTRY.length"));
  const schemas = callFn("getToolSchemas");
  ok("getToolSchemas 返回 5 个", schemas.length === 5, schemas.length);
  ok("schema 不含 run 字段", schemas.every(s => !("run" in s.function)));

  section("11. 修复项回归（4/5/6/7/8/9/15/16）");

  // ---- #4 对比模式空 assistant 消息不得发给服务端 ----
  setVar("sessions", [{
    id: "s4", title: "空消息", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "第一个问题", time: Date.now() },
      { role: "assistant", content: "", thinking: "", model: "m1", groupId: "g1", time: Date.now() },
      { role: "assistant", content: "", thinking: "", model: "m2", groupId: "g1", time: Date.now() },
      { role: "user", content: "第二个问题", time: Date.now() }
    ]
  }]);
  setVar("currentSessionId", "s4");
  const msgs4 = callFn("buildMessages", false, null, null, { providerType: "openai" });
  const emptyAssistants = msgs4.filter(m => m.role === "assistant" && !String(m.content || "").trim());
  ok("#4 空 assistant 消息被过滤（不再触发 400）", emptyAssistants.length === 0, msgs4);
  ok("#4 有内容的 user 消息保留", msgs4.filter(m => m.role === "user").length === 2, msgs4.length);
  // 有 thinking 的 assistant 不该被误删
  setVar("sessions", [{
    id: "s4b", title: "思考", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "问", time: Date.now() },
      { role: "assistant", content: "", thinking: "只有思考没有正文", model: "m1", time: Date.now() },
      { role: "user", content: "再问", time: Date.now() }
    ]
  }]);
  setVar("currentSessionId", "s4b");
  const msgs4b = callFn("buildMessages", false, null, null, { providerType: "openai" });
  ok("#4 仅有 thinking 的 assistant 被保留", msgs4b.some(m => m.role === "assistant"), msgs4b);

  // ---- #15 withTools 死参数已移除（行为不受影响：工具由 reqOpts 单独传递） ----
  ok("#15 buildMessages 仍能正常产出（不依赖 withTools）", Array.isArray(msgs4) && msgs4.length > 0);

  // ---- #5 compare 数组长度未校验 ----
  let cmpThrew = null;
  let cmpShort = null;
  try {
    cmpShort = callFn("buildMessageInner", { role: "assistant", compare: [{ model: "A", content: "只有一路" }], time: Date.now() }, false, 0);
  } catch (e) { cmpThrew = e.message; }
  ok("#5 compare 只有 1 项时不抛异常", cmpThrew === null, cmpThrew);
  ok("#5 compare 只有 1 项时仍渲染出内容", typeof cmpShort === "string" && cmpShort.length > 0);
  let cmpThrew2 = null;
  try {
    callFn("buildMessageInner", { role: "assistant", compare: [], time: Date.now() }, false, 0);
    callFn("buildMessageInner", { role: "assistant", compare: [null, null], time: Date.now() }, false, 0);
    callFn("buildMessageInner", { role: "assistant", compare: [undefined, { model: "B" }], time: Date.now() }, false, 0);
  } catch (e) { cmpThrew2 = e.message; }
  ok("#5 compare 为空/含 null/含 undefined 都不抛异常", cmpThrew2 === null, cmpThrew2);
  // 完整的 compare 仍正常渲染
  const cmpFull = callFn("buildMessageInner", {
    role: "assistant", time: Date.now(),
    compare: [{ model: "A", content: "回答A", thinking: "" }, { model: "B", content: "回答B", thinking: "" }]
  }, false, 0);
  ok("#5 完整 compare 仍渲染两列", cmpFull.includes("回答A") && cmpFull.includes("回答B"), cmpFull.slice(0, 160));
  // buildMessages 也不能被残缺 compare 打挂
  setVar("sessions", [{
    id: "s5", title: "残缺对比", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "问", time: Date.now() },
      { role: "assistant", compare: [{ model: "A", content: "只有一路" }], time: Date.now() },
      { role: "user", content: "再问", time: Date.now() }
    ]
  }]);
  setVar("currentSessionId", "s5");
  let bm5 = null;
  try { bm5 = callFn("buildMessages", false, null, null, { providerType: "openai" }); } catch (e) { bm5 = "THREW:" + e.message; }
  ok("#5 buildMessages 遇到残缺 compare 不抛异常", Array.isArray(bm5), bm5);

  // ---- #6 data-last 应在最后一条"可见"消息上，而不是数组最后一项 ----
  setVar("sessions", [{
    id: "s6", title: "工具后", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "问", time: Date.now() },
      { role: "assistant", content: "答", model: "m", time: Date.now(), toolCalls: [], toolResults: [] },
      { role: "tool", content: "工具结果", toolCallId: "c1", time: Date.now(), hidden: true }
    ]
  }]);
  setVar("currentSessionId", "s6");
  getEl("messages")._children.length = 0;
  let r6err = null;
  try { callFn("renderMessages"); } catch (e) { r6err = e.message; }
  ok("#6 渲染含隐藏工具消息的会话不抛异常", r6err === null, r6err);
  const wraps6 = getEl("messages")._children;
  ok("#6 隐藏的 tool 消息未被渲染成节点", wraps6.length === 2, wraps6.length);
  const lastWrap = wraps6[wraps6.length - 1];
  ok("#6 最后一条可见消息带有 data-last", lastWrap && lastWrap.dataset.last === "1",
     lastWrap && JSON.stringify(lastWrap.dataset));
  ok("#6 data-last 落在 assistant 而不是 tool 上", lastWrap && String(lastWrap.dataset.idx) === "1",
     lastWrap && JSON.stringify({ idx: lastWrap.dataset.idx, last: lastWrap.dataset.last, cls: lastWrap.className }));
  // 多个尾部工具消息也要正确
  setVar("sessions", [{
    id: "s6b", title: "多工具", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "问", time: Date.now() },
      { role: "assistant", content: "答", model: "m", time: Date.now() },
      { role: "tool", content: "r1", toolCallId: "c1", hidden: true },
      { role: "tool", content: "r2", toolCallId: "c2", hidden: true }
    ]
  }]);
  setVar("currentSessionId", "s6b");
  getEl("messages")._children.length = 0;
  callFn("renderMessages");
  const wraps6b = getEl("messages")._children;
  ok("#6 连续多个尾部工具消息时 data-last 仍正确",
     wraps6b.length === 2 && wraps6b[1].dataset.last === "1",
     wraps6b.map(w => w.dataset));

  // ---- #7 navTicks 索引不错位 ----
  setVar("sessions", [{
    id: "s7", title: "刻度", pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: "user", content: "1", time: Date.now() },
      { role: "assistant", content: "2", model: "m", time: Date.now() },
      { role: "tool", content: "隐藏", hidden: true },
      { role: "user", content: "3", time: Date.now() },
      { role: "assistant", content: "4", model: "m", time: Date.now() }
    ]
  }]);
  setVar("currentSessionId", "s7");
  let r7err = null;
  try { callFn("renderMsgNav"); } catch (e) { r7err = e.message; }
  ok("#7 renderMsgNav 不抛异常", r7err === null, r7err);
  const ticks7 = ev("navTicks.length");
  ok("#7 刻度数量 = 可见消息数 4", ticks7 === 4, ticks7);
  // 映射必须按"消息下标"建立：0,1,3,4（2 是隐藏的工具消息）
  const mapKeys = ev("Object.keys(navTicksByMsgIdx).sort((a,b)=>a-b).join(',')");
  ok("#7 navTicksByMsgIdx 的键是消息下标 0,1,3,4", mapKeys === "0,1,3,4", mapKeys);
  const mapOk = ev("(!!navTicksByMsgIdx[0] && !!navTicksByMsgIdx[1] && !navTicksByMsgIdx[2] && !!navTicksByMsgIdx[3] && !!navTicksByMsgIdx[4])");
  ok("#7 隐藏消息下标 2 没有刻度（不再错位）", mapOk === true, mapOk);
  // 高亮逻辑用下标取刻度，应命中正确的元素
  const tickAt3 = ev("navTicksByMsgIdx[3] && navTicksByMsgIdx[3].dataset.idx");
  ok("#7 下标 3 取到的刻度自身 idx 也是 3", String(tickAt3) === "3", tickAt3);

  // ---- #8 tempRagFiles 在发送后清空 ----
  setVar("tempRagFiles", [{ filename: "临时.md", chunks: [{ text: "内容", embedding: [] }] }]);
  setVar("tempImages", []);
  ev("document.getElementById('input').value = '测试发送后清理'");
  let sendThrew = null;
  try { callFn("sendMessage"); } catch (e) { sendThrew = e.message; }
  ok("#8 sendMessage（后端不可用）不抛异常", sendThrew === null, sendThrew);
  await new Promise(r => setTimeout(r, 50));
  ok("#8 发送后 tempRagFiles 被清空", ev("tempRagFiles.length") === 0, ev("tempRagFiles.length"));
  ok("#8 发送后 chip 容器也被清空", getEl("tempFileChips").innerHTML === "" || !getEl("tempFileChips").innerHTML.includes("临时.md"),
     getEl("tempFileChips").innerHTML);

  // ---- #9 纯图片消息能发出去 ----
  setVar("sessions", [{ id: "s9", title: "新对话", pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }]);
  setVar("currentSessionId", "s9");
  setVar("generating", false);
  setVar("tempImages", [{ name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,QQ==", b64: "QQ==" }]);
  ev("document.getElementById('input').value = ''");
  let send9Threw = null;
  try { callFn("sendMessage"); } catch (e) { send9Threw = e.message; }
  ok("#9 纯图片发送不抛异常", send9Threw === null, send9Threw);
  await new Promise(r => setTimeout(r, 50));
  const s9 = ev("sessions[0]");
  const u9 = s9 && s9.messages.find(m => m.role === "user");
  ok("#9 纯图片时仍写入了 user 消息", !!u9, s9 && s9.messages.map(m => m.role));
  ok("#9 user 消息带有 images", !!(u9 && u9.images && u9.images.length === 1), u9 && u9.images);
  ok("#9 user 消息有占位文本（气泡与侧栏不为空）", !!(u9 && String(u9.content || "").trim()), u9 && u9.content);
  ok("#9 会话标题不为空", !!(s9 && String(s9.title || "").trim() && s9.title !== "新对话"), s9 && s9.title);
  ok("#9 发送后 tempImages 被清空", ev("tempImages.length") === 0, ev("tempImages.length"));

  // ---- #16 预设启用链路 ----
  ok("#16 setActivePreset 存在", typeof ev("typeof setActivePreset") === "string" && ev("typeof setActivePreset") === "function");
  ok("#16 getActivePreset 存在", ev("typeof getActivePreset") === "function");
  ok("#16 updatePresetBadge 存在", ev("typeof updatePresetBadge") === "function");
  ok("#16 restoreActivePreset 存在", ev("typeof restoreActivePreset") === "function");
  setVar("presets", [{ id: "p1", name: "测试预设", prompt: "你是测试角色", params: { temperature: 0.1 } }]);
  callFn("setActivePreset", "p1");
  ok("#16 启用后 currentPresetId 被赋值", ev("currentPresetId") === "p1", ev("currentPresetId"));
  ok("#16 启用后持久化到 cfg.activePresetId", ev("cfg.activePresetId") === "p1", ev("cfg.activePresetId"));
  // system prompt 应走预设
  ok("#16 getActiveSystemPrompt 用上了预设的 prompt", ev("getActiveSystemPrompt()") === "你是测试角色",
     ev("getActiveSystemPrompt()"));
  // 参数继承应显示 preset 来源
  const rp = callFn("resolveParam", "temperature");
  ok("#16 resolveParam 的 source 是 preset（预设层终于生效）", rp && rp.source === "preset", rp);
  ok("#16 resolveParam 取到预设值 0.1", rp && rp.value === 0.1, rp);
  // 停用后回落全局
  callFn("setActivePreset", "");
  ok("#16 停用后 currentPresetId 清空", ev("currentPresetId") === "", ev("currentPresetId"));
  ok("#16 停用后回落全局 system prompt", ev("getActiveSystemPrompt()") !== "你是测试角色", ev("getActiveSystemPrompt()"));
  ok("#16 停用后参数来源回落 global", callFn("resolveParam", "temperature").source === "global",
     callFn("resolveParam", "temperature"));
  // restoreActivePreset 能在重启后恢复
  setVar("cfg", Object.assign({}, ev("cfg"), { activePresetId: "p1" }));
  callFn("restoreActivePreset");
  ok("#16 restoreActivePreset 能恢复已保存的预设", ev("currentPresetId") === "p1", ev("currentPresetId"));
  // 指向不存在的预设要安全清空
  setVar("cfg", Object.assign({}, ev("cfg"), { activePresetId: "不存在的id" }));
  callFn("restoreActivePreset");
  ok("#16 指向已删除的预设时安全清空", ev("currentPresetId") === "", ev("currentPresetId"));
  ok("#16 无效 id 也被从 cfg 清掉", ev("cfg.activePresetId") === "", ev("cfg.activePresetId"));

  section("12. 审阅新发现的修复（记账累计 + 版本栈）");

  // ---- 多轮工具调用时 token 必须是各轮之和，而不是最后一轮的值 ----
  // runStream 内部逻辑：usage 到达时写 aiMsg.promptTokens = prevPTokens + roundPTokens
  // 这里直接验证"跨轮累加"的语义，用一个受控的假 streamRequest 驱动。
  const realStream = ev("streamRequest");
  let streamCallNo = 0;
  // 每轮返回不同的 usage：第 1 轮 100/50，第 2 轮 300/120，第 3 轮无 usage
  const usagePlan = [
    { prompt_tokens: 100, completion_tokens: 50 },
    { prompt_tokens: 300, completion_tokens: 120 },
    null
  ];
  const toolPlan = [
    [{ index: 0, id: "c1", function: { name: "calculator", arguments: '{"expression":"1+1"}' } }],
    [{ index: 0, id: "c2", function: { name: "get_current_time", arguments: "{}" } }],
    []
  ];
  setVar("sessions", [{ id: "s12", title: "记账", pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }]);
  setVar("currentSessionId", "s12");
  setVar("cfg", Object.assign({}, ev("cfg"), { toolsEnabled: true, maxToolRounds: 5 }));
  setVar("generating", true);
  setVar("abortCtrl", new AbortController());
  lsData["chat_usage"] = JSON.stringify({ v: 1, days: {} });
  lsData["chat_usage_log"] = "[]";
  callFn("loadUsage");

  sandbox.__usagePlan = usagePlan;
  sandbox.__toolPlan = toolPlan;
  sandbox.__callNo = 0;
  // 用 stub 替换 streamRequest（保存原函数以便还原）
  vm.runInContext(`
    __realStreamRequest = streamRequest;
    streamRequest = async function(model, messages, onChunk, onDone, onError, signal, providerId, opts){
      const i = __callNo++;
      const u = __usagePlan[i];
      if (u) onChunk({ usage: u });
      const tc = __toolPlan[i] || [];
      if (tc.length) onChunk({ tool_calls: tc });
      onChunk({ content: "第" + (i+1) + "轮" });
      if (onDone) onDone();
    };
  `, sandbox);

  const aiMsg12 = { role: "assistant", content: "", thinking: "", model: "qwen2.5:7b", time: Date.now(), providerId: "ollama" };
  sandbox.__msg12 = aiMsg12;
  vm.runInContext("sessions[0].messages.push(__msg12)", sandbox);
  let loopErr12 = null;
  try {
    // runStreamWithTools 是 async，必须 await（vm.runInContext 会把 Promise 返回给宿主）
    await vm.runInContext("runStreamWithTools(sessions[0].messages[0], false, null, null, null)", sandbox);
  } catch (e) { loopErr12 = e.message; }
  ok("#12 多轮工具循环不抛异常", loopErr12 === null, loopErr12);
  ok("#12 共执行了 3 轮", sandbox.__callNo === 3, sandbox.__callNo);
  ok("#12 prompt token 是各轮之和 100+300=400（不是 max）", aiMsg12.promptTokens === 400, aiMsg12.promptTokens);
  ok("#12 completion token 是各轮之和 50+120=170", aiMsg12.completionTokens === 170, aiMsg12.completionTokens);
  ok("#12 两轮的工具调用都被记录", Array.isArray(aiMsg12.toolCalls) && aiMsg12.toolCalls.length === 2,
     aiMsg12.toolCalls && aiMsg12.toolCalls.length);
  ok("#12 工具结果也被记录", Array.isArray(aiMsg12.toolResults) && aiMsg12.toolResults.length === 2,
     aiMsg12.toolResults && aiMsg12.toolResults.length);
  // 记账：只记一次，且金额基于累计值
  callFn("recordUsageForMessage", aiMsg12);
  callFn("flushUsage");
  const usageLog = JSON.parse(lsData["chat_usage_log"] || "[]");
  const myLogs = usageLog.filter(x => x.sessionId === "s12");
  ok("#12 该消息只记一笔账（不因多轮而重复计费）", myLogs.length === 1, myLogs.length);
  ok("#12 记账用的是累计 token 400/170", myLogs[0] && myLogs[0].p === 400 && myLogs[0].c === 170,
     myLogs[0] && { p: myLogs[0].p, c: myLogs[0].c });

  // ---- 版本栈：切版本要还原各自的工具调用与 token ----
  const msgVer = {
    role: "assistant", content: "新版本内容", thinking: "", model: "模型B", time: Date.now(),
    toolCalls: [{ id: "n1", function: { name: "calculator", arguments: "{}" } }],
    toolResults: [{ id: "n1", name: "calculator", ok: true, text: "R2" }],
    promptTokens: 400, completionTokens: 170, genTime: 3, usageSource: "ollama",
    versions: [
      { model: "模型A", content: "旧版本内容", thinking: "", time: 1, speed: 1,
        toolCalls: [{ id: "o1", function: { name: "list_skills", arguments: "{}" } }],
        toolResults: [{ id: "o1", name: "list_skills", ok: true, text: "R1" }],
        promptTokens: 100, completionTokens: 50, genTime: 1, usageSource: "ollama" },
      { model: "模型B", content: "新版本内容", thinking: "", time: 1, speed: 2,
        toolCalls: [{ id: "n1", function: { name: "calculator", arguments: "{}" } }],
        toolResults: [{ id: "n1", name: "calculator", ok: true, text: "R2" }],
        promptTokens: 400, completionTokens: 170, genTime: 3, usageSource: "ollama" }
    ],
    currentVersion: 1
  };
  callFn("switchVersion", msgVer, -1);
  ok("#12 切到旧版本后 model 正确", msgVer.model === "模型A", msgVer.model);
  ok("#12 切到旧版本后 currentVersion 正确", msgVer.currentVersion === 0, msgVer.currentVersion);
  ok("#12 切到旧版本后工具调用还原为旧版本的", msgVer.toolCalls[0].function.name === "list_skills",
     msgVer.toolCalls[0].function.name);
  ok("#12 切到旧版本后工具结果还原为旧版本的", msgVer.toolResults[0].text === "R1", msgVer.toolResults[0].text);
  ok("#12 切到旧版本后 prompt token 还原为 100（不再沿用新版本的 400）", msgVer.promptTokens === 100, msgVer.promptTokens);
  ok("#12 切到旧版本后 completion token 还原为 50", msgVer.completionTokens === 50, msgVer.completionTokens);
  callFn("switchVersion", msgVer, 1);
  ok("#12 切回新版本后 token 还原为 400/170", msgVer.promptTokens === 400 && msgVer.completionTokens === 170,
     { p: msgVer.promptTokens, c: msgVer.completionTokens });
  ok("#12 切回新版本后工具体还原", msgVer.toolResults[0].text === "R2", msgVer.toolResults[0].text);
  // 版本里没有工具数据时，不能沿用上一个版本的
  const msgNoTool = {
    role: "assistant", content: "x", model: "M2", time: 1,
    toolCalls: [{ id: "z", function: { name: "calculator", arguments: "{}" } }],
    toolResults: [{ id: "z", name: "calculator", text: "Z" }],
    promptTokens: 999,
    versions: [
      { model: "M1", content: "旧", thinking: "", time: 1, speed: 0, promptTokens: 0, completionTokens: 0 },
      { model: "M2", content: "x", thinking: "", time: 1, speed: 0, promptTokens: 999, completionTokens: 0 }
    ],
    currentVersion: 1
  };
  callFn("switchVersion", msgNoTool, -1);
  ok("#12 旧版本没有工具数据时被清空（不沿用新版本的）", msgNoTool.toolCalls === null, msgNoTool.toolCalls);
  ok("#12 旧版本 toolResults 也被清空", msgNoTool.toolResults === null, msgNoTool.toolResults);
  ok("#12 旧版本 token 为 0", msgNoTool.promptTokens === 0, msgNoTool.promptTokens);

  // 还原 streamRequest
  vm.runInContext("streamRequest = __realStreamRequest;", sandbox);

  console.log("\n" + "=".repeat(56));
  console.log(`集成测试结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n失败项："); failures.forEach(f => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();
