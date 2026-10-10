// ============ 持久化模块 ============
//
// 「数据要活过刷新」这条不变量的唯一主人。
//
// 词汇见 GLOSSARY.md：持久化模块 · 状态切片 · 存储后端 · 单一真值源 · 落盘状态
//
// 调用方的三种喊法（越靠下越强）：
//   persist(name)     —— 「这片变了」：节流合批。热路径用它。
//   persistNow(name)  —— 「立刻写下去」：关键动作用它。本地写失败会同步抛出。
//   flushPersist()    —— 「把所有积压写掉」：页面隐藏 / 关闭时用它。
//
// 设计约定（2026-10 与用户逐条确认）：
//   · 单一真值源：会话数据集要么住本地存储、要么住绑定文件夹，绝不同时住两处。
//   · 只接受依赖，不自己创建：两个存储后端可以从外面换掉（见 configurePersistence）。
//   · 落盘状态只报告事实，「怎么呈现」由界面决定。
//   · 本地写入保持同步并同步抛出 —— importer 的配额回滚依赖这个语义。

// =====================================================================
// 1. 键名清单
// =====================================================================
// 「有哪些数据要存」只在这里回答一次。任何地方都不该再出现硬编码的存储键。
const PERSIST_KEY = {
  cfg:        "chat_cfg",
  sessions:   "chat_sessions",
  presets:    "chat_presets",
  drafts:     "chat_drafts",
  usage:      "chat_usage",
  usageLog:   "chat_usage_log",
  statsRange: "chat_stats_range",
  statsGroup: "chat_stats_group",
};

// 非 localStorage 的持久化位置，同样登记在这里（不再散落成字面量）
const PERSIST_DB   = { name: "chat_db", store: "kv", folderHandleKey: "folderHandle" };
const PERSIST_FILE = "conversations.json";

// 写进 conversations.json 的格式版本
const PERSIST_FORMAT_VERSION = "1.24";

// 节流间隔：热路径（流式输出、打字）用它合批
const PERSIST_THROTTLE_MS = 800;

// =====================================================================
// 2. 状态切片表
// =====================================================================
// home:
//   "local"          —— 只住本地存储（小、属于这台机器）
//   "conversations"  —— 会话数据集：绑定了文件夹就住磁盘，否则住本地存储
// weight:
//   "critical"       —— 写失败必须让用户知道
//   "disposable"     —— 写失败记一笔即可，可以放弃
//
// 注：usage / statsPrefs 的键已在上面登记，但它们目前仍由 js/features/stats.js
// 自己写（它自带 800ms 节流与卸载落盘）。把它们的写入也收进来是后续的迁移步骤。
const PERSIST_SLICES = {
  cfg:      { home: "local",         weight: "critical" },
  drafts:   { home: "local",         weight: "disposable" },
  sessions: { home: "conversations", weight: "critical" },
  presets:  { home: "conversations", weight: "critical" },
};

// 切片 → 全局量。这个项目没有模块系统，状态就是全局量；
// 集中登记在这一处，调用方与测试都不需要知道哪个文件定义了哪个名字。
const PERSIST_READ = {
  cfg:      () => cfg,
  drafts:   () => drafts,
  sessions: () => sessions,
  presets:  () => presets,
};

// =====================================================================
// 3. 存储后端（适配器）
// =====================================================================
// 默认后端：浏览器本地存储。测试用 configurePersistence 换成内存实现。
function makeLocalBackend() {
  return {
    kind: "local",
    getItem(k) { return localStorage.getItem(k); },
    setItem(k, v) { localStorage.setItem(k, v); },
    removeItem(k) { localStorage.removeItem(k); },
  };
}

// 默认后端：绑定的文件夹（File System Access）。
// read() 在文件不存在时返回 null；其它任何失败都抛出 ——
// 由调用方决定怎么报，绝不静默当成「空」。
function makeFolderBackend(handle) {
  return {
    kind: "folder",
    name: (handle && handle.name) || "",
    async ensurePermission() {
      if (!handle) return false;
      const opts = { mode: "readwrite" };
      try {
        if (await handle.queryPermission(opts) === "granted") return true;
        if (await handle.requestPermission(opts) === "granted") return true;
      } catch (e) { return false; }
      return false;
    },
    async read() {
      let fh;
      try {
        fh = await handle.getFileHandle(PERSIST_FILE);
      } catch (e) {
        // 文件还不存在 —— 这不是错误，是「还没有数据」
        if (e && (e.name === "NotFoundError" || e.code === 8)) return null;
        throw e;
      }
      const file = await fh.getFile();
      const text = await file.text();
      if (!text || !text.trim()) return null;
      return JSON.parse(text);
    },
    async write(payload) {
      const fh = await handle.getFileHandle(PERSIST_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(payload, null, 2));
      await w.close();
    },
  };
}

let _localBackend = (typeof localStorage !== "undefined" && localStorage) ? makeLocalBackend() : null;
let _folderBackend = null;   // 绑定文件夹之后才有

// 非 null 表示「这个文件夹读过一次、失败了」。
// 在重新读成功之前不允许写入 —— 见 _writeConversationsRaw 的说明。
let _folderBlocked = null;

// 只接受依赖，不自己创建。测试传内存实现进来，生产用默认的两个。
function configurePersistence(opts) {
  opts = opts || {};
  if (opts.local !== undefined) _localBackend = opts.local;
  if (opts.folder !== undefined) { _folderBackend = opts.folder; _folderBlocked = null; }
  _persistSnap.home = conversationsHome();
  return { local: _localBackend, folder: _folderBackend };
}

function getFolderBackend() { return _folderBackend; }
function setFolderBackend(backend) {
  _folderBackend = backend || null;
  _folderBlocked = null;      // 换了文件夹就重新信任它
  _persistSnap.home = conversationsHome();
  _emitPersistStatus();
}

// 会话数据集现在住哪儿 —— 单一真值源在这里被裁决
function conversationsHome() { return _folderBackend ? "disk" : "local"; }

// =====================================================================
// 4. 落盘状态（只报告事实）
// =====================================================================
const _persistSnap = {
  ok: true,        // 有没有未解决的失败
  home: "local",   // 会话数据集现在住哪儿
  pending: [],     // 等着的切片名
  inFlight: [],    // 正在写的切片名（磁盘写是异步的）
  lastError: null, // { slice, message, weight, at }
  lastOkAt: 0,
};
const _persistListeners = [];

function persistStatus() {
  return {
    ok: _persistSnap.ok,
    home: conversationsHome(),
    pending: _persistSnap.pending.slice(),
    inFlight: _persistSnap.inFlight.slice(),
    lastError: _persistSnap.lastError ? { ..._persistSnap.lastError } : null,
    lastOkAt: _persistSnap.lastOkAt,
  };
}

// 订阅落盘状态。返回取消订阅的函数。
function onPersistStatus(fn) {
  if (typeof fn !== "function") return () => {};
  _persistListeners.push(fn);
  return function off() {
    const i = _persistListeners.indexOf(fn);
    if (i >= 0) _persistListeners.splice(i, 1);
  };
}

function _emitPersistStatus() {
  const snap = persistStatus();
  _persistListeners.forEach(function (fn) {
    try { fn(snap); } catch (e) { /* 订阅者自己出错，不能影响落盘 */ }
  });
}

function _weightOf(name) {
  return (PERSIST_SLICES[name] && PERSIST_SLICES[name].weight) || "disposable";
}

function _reportPersistError(name, e) {
  const msg = String((e && e.message) || e || "未知错误");
  _persistSnap.ok = false;
  _persistSnap.lastError = { slice: name, message: msg, weight: _weightOf(name), at: Date.now() };
  if (_weightOf(name) === "critical") {
    console.error("❌ 落盘失败（不能放弃）：" + name + " —— " + msg);
  } else {
    console.warn("⚠️ 落盘失败（可放弃）：" + name + " —— " + msg);
  }
  _emitPersistStatus();
}

function _markOk() {
  _persistSnap.lastOkAt = Date.now();
  // 只有所有积压都清了，才算恢复正常
  if (!_persistSnap.pending.length && !_persistSnap.inFlight.length) {
    if (!_persistSnap.ok) {
      _persistSnap.ok = true;
      _persistSnap.lastError = null;
    }
  }
  _emitPersistStatus();
}

// 异步写（磁盘）的成败都要落进状态里 —— 这是「磁盘写失败完全不可观测」的答案
function _trackAsync(promise, name) {
  if (!promise || typeof promise.then !== "function") return promise;
  _persistSnap.inFlight.push(name);
  _emitPersistStatus();
  return promise.then(
    function (r) {
      _persistSnap.inFlight = _persistSnap.inFlight.filter(function (x) { return x !== name; });
      _markOk();
      return r;
    },
    function (e) {
      _persistSnap.inFlight = _persistSnap.inFlight.filter(function (x) { return x !== name; });
      _reportPersistError(name, e);
      return null;
    }
  );
}

// =====================================================================
// 5. 写入的实现
// =====================================================================
// 本地存储：同步写。失败同步抛出 —— importer 的配额回滚依赖这个语义。
function _writeLocalSlice(name) {
  if (!_localBackend) throw new Error("没有本地存储后端");
  _localBackend.setItem(PERSIST_KEY[name], JSON.stringify(PERSIST_READ[name]()));
}

// 会话数据集：写进它现在唯一的家。
// home=local 时同步；home=disk 时返回 Promise。
function _writeConversationsRaw() {
  if (conversationsHome() === "local") {
    _localBackend.setItem(PERSIST_KEY.sessions, JSON.stringify(sessions));
    _localBackend.setItem(PERSIST_KEY.presets, JSON.stringify(presets));
    return null;
  }
  // 读不出来过？那就不要往它里面写。
  // 否则「文件夹权限被撤销 → 读失败 → 内存是空的 → 下一次保存把空数据写回去」
  // 会直接毁掉用户原有的 conversations.json。
  if (_folderBlocked) {
    throw new Error("文件夹读取失败过（" + _folderBlocked + "），已暂停写入以免覆盖原有数据");
  }
  const payload = {
    version: PERSIST_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    sessions: sessions,
    presets: presets,
  };
  return _folderBackend.write(payload);
}

// 同一个 tick / 同一次飞行里重复请求只写一次。
// saveLocal() 和 saveToDisk() 成对出现的地方（24 处）因此不会写两遍磁盘。
// 若写入期间又来了请求，落定后补写一次，信号不会丢。
let _convInFlight = null;
let _convAgain = false;
function _writeConversations() {
  if (_convInFlight) { _convAgain = true; return _convInFlight; }
  const p = _writeConversationsRaw();
  if (!p || typeof p.then !== "function") return p;
  _convInFlight = p.then(
    function (r) {
      _convInFlight = null;
      if (_convAgain) { _convAgain = false; return _writeConversations(); }
      return r;
    },
    function (e) {
      _convInFlight = null;
      _convAgain = false;
      throw e;
    }
  );
  return _convInFlight;
}

// 单一真值源：确认磁盘有数据之后，清掉本地存储里那份过期副本，
// 免得将来有代码误把它当成真值读回去。
function _clearStaleLocalCopy() {
  if (!_localBackend) return;
  try {
    _localBackend.removeItem(PERSIST_KEY.sessions);
    _localBackend.removeItem(PERSIST_KEY.presets);
  } catch (e) { /* 删不掉就算了 —— 它本来就不是真值源 */ }
}

// 把一批切片名分成「本地」和「会话数据集」两组，各自只写一次
function _partition(names) {
  return {
    locals: names.filter(function (n) { return PERSIST_SLICES[n].home === "local"; }),
    conv: names.some(function (n) { return PERSIST_SLICES[n].home === "conversations"; }),
  };
}

// =====================================================================
// 6. 对外接口：喊「变了」
// =====================================================================
let _pendingSlices = {};
let _persistTimer = null;
let _lastWriteAt = 0;

function _normalizeSliceArg(name) {
  if (name === undefined || name === null || name === "all") return Object.keys(PERSIST_SLICES);
  if (Array.isArray(name)) return name.filter(function (n) { return PERSIST_SLICES[n]; });
  return PERSIST_SLICES[name] ? [name] : [];
}

function _syncPendingField() {
  _persistSnap.pending = Object.keys(_pendingSlices);
  _emitPersistStatus();
}

// 节流合批。热路径用它。
function persist(name) {
  _normalizeSliceArg(name).forEach(function (n) { _pendingSlices[n] = true; });
  if (!Object.keys(_pendingSlices).length) return;

  const elapsed = Date.now() - _lastWriteAt;
  if (elapsed >= PERSIST_THROTTLE_MS) { _flushPending(); return; }
  _syncPendingField();
  if (_persistTimer) return;
  _persistTimer = setTimeout(function () {
    _persistTimer = null;
    _flushPending();
  }, PERSIST_THROTTLE_MS - elapsed);
}

function _flushPending() {
  const names = Object.keys(_pendingSlices);
  if (!names.length) { _syncPendingField(); return; }
  _pendingSlices = {};

  const g = _partition(names);
  let syncError = null;

  g.locals.forEach(function (n) {
    try { _writeLocalSlice(n); }
    catch (e) { if (!syncError) syncError = e; _reportPersistError(n, e); }
  });
  if (g.conv) {
    try { _trackAsync(_writeConversations(), "sessions"); }
    catch (e) { if (!syncError) syncError = e; _reportPersistError("sessions", e); }
  }

  _lastWriteAt = Date.now();
  _syncPendingField();
  if (!syncError) _markOk();
}

// 立刻写。关键动作用它。
// · 本地存储片：同步写，失败同步抛出 ——「导入到一半配额不够要回滚」依赖这个。
// · 会话数据集：磁盘写是异步的，成败进落盘状态，不抛出。这一点很重要：
//   saveLocal / saveToDisk 这两个旧名字在 84 个调用点上被调用，它们历史上从不抛
//   （saveToDisk 整个函数体裹在 catch(e){} 里），突然开始抛会打断业务流程。
function persistNow(name) {
  const names = _normalizeSliceArg(name);
  names.forEach(function (n) { delete _pendingSlices[n]; });

  const g = _partition(names);
  let firstLocalError = null;

  g.locals.forEach(function (n) {
    try { _writeLocalSlice(n); }
    catch (e) { if (!firstLocalError) firstLocalError = e; _reportPersistError(n, e); }
  });
  if (g.conv) {
    try { _trackAsync(_writeConversations(), "sessions"); }
    catch (e) { _reportPersistError("sessions", e); }
  }

  _lastWriteAt = Date.now();
  _syncPendingField();
  if (firstLocalError) throw firstLocalError;
}

// 把积压全部写掉，并保证磁盘不落后于内存。页面隐藏 / 关闭时用它。
function flushPersist() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  _flushPending();

  // 即便没有积压，也补一次会话数据集 —— 「关闭时只写 localStorage 不写磁盘」
  // 正是原来丢数据的机制。
  try { _trackAsync(_writeConversations(), "sessions"); }
  catch (e) { _reportPersistError("sessions", e); }

  // 统计那边自己有一套节流，喊一声让它也落下去
  if (typeof flushUsage === "function") {
    try { flushUsage(); } catch (e) { /* 统计是可放弃的数据 */ }
  }
}

// 立即重试。界面上的「重试」调它。
function retryPersist() {
  Object.keys(PERSIST_SLICES).forEach(function (n) { _pendingSlices[n] = true; });
  _flushPending();
  return persistStatus();
}

// =====================================================================
// 7. 读出
// =====================================================================
// 本地存储那一半 + 归一化。
// 会话数据集在这里「试探性」读进来，好让下面 loadConversations() 拿它当迁移来源；
// 真正谁说了算由 loadConversations() 裁决。
function loadLocalState() {
  if (!_localBackend) return;

  try { Object.assign(cfg, JSON.parse(_localBackend.getItem(PERSIST_KEY.cfg) || "{}")); } catch (e) { }
  try { sessions = JSON.parse(_localBackend.getItem(PERSIST_KEY.sessions) || "[]"); } catch (e) { sessions = []; }
  try { presets  = JSON.parse(_localBackend.getItem(PERSIST_KEY.presets)  || "[]"); } catch (e) { presets = []; }
  try { drafts   = JSON.parse(_localBackend.getItem(PERSIST_KEY.drafts)   || "{}"); } catch (e) { drafts = {}; }

  if (!Array.isArray(sessions)) sessions = [];
  if (!Array.isArray(presets)) presets = [];
  if (!drafts || typeof drafts !== "object") drafts = {};
  if (!cfg.quickPrompts || !Array.isArray(cfg.quickPrompts)) cfg.quickPrompts = ["翻译", "总结", "改代码"];
  if (!cfg.emoMap || typeof cfg.emoMap !== "object" || Array.isArray(cfg.emoMap)) cfg.emoMap = {};
  if (!cfg.ragUrl) cfg.ragUrl = DEFAULT_CFG.ragUrl;
  if (!cfg.num_predict) cfg.num_predict = 1024;
  if (cfg.activePresetId === undefined) cfg.activePresetId = "";

  // 兼容旧版配置：没有 providers 时，按旧版 url 生成一个
  if (!cfg.providers || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    cfg.providers = [{
      id: "ollama",
      type: "ollama",
      name: "本地 Ollama",
      baseUrl: cfg.url || "http://127.0.0.1:11434",
      apiKey: "",
    }];
  }
  delete cfg.url;
}

// 会话数据集那一半：按单一真值源裁决。
// 返回 { source }：local | disk | migrated | empty | disk-unreadable
async function loadConversations() {
  if (conversationsHome() === "local") {
    // loadLocalState() 已经读进来了
    return { source: "local" };
  }

  let data = null;
  try {
    if (_folderBackend.ensurePermission) {
      const ok = await _folderBackend.ensurePermission();
      if (!ok) throw new Error("没有文件夹的读写权限");
    }
    data = await _folderBackend.read();
  } catch (e) {
    // 读不出来就明确报错，绝不静默回滚成空。
    // 内存里那份试用副本保持不动，用户至少还能看到东西。
    // 同时上锁：在重新读成功之前不往这个文件夹写（否则会把空数据覆盖上去）。
    _folderBlocked = String((e && e.message) || e);
    _reportPersistError("sessions", e);
    return { source: "disk-unreadable", error: e };
  }

  _folderBlocked = null;             // 读通了，解锁
  if (data && Array.isArray(data.sessions)) {
    sessions = data.sessions;
    presets = Array.isArray(data.presets) ? data.presets : [];
    _clearStaleLocalCopy();          // 磁盘是唯一的家，本地那份过期副本清掉
    return { source: "disk" };
  }

  // 文件不存在或为空：把试用副本（来自本地存储）搬进磁盘。
  // 这是老用户第一次跑新版本时的搬家路径 —— 少了它就会静默丢数据。
  const hasSomething = (Array.isArray(sessions) && sessions.length > 0) ||
                       (Array.isArray(presets) && presets.length > 0);
  if (hasSomething) {
    await _trackAsync(_writeConversations(), "sessions");
    _clearStaleLocalCopy();
    return { source: "migrated" };
  }
  _clearStaleLocalCopy();
  return { source: "empty" };
}

// ---- 绑定文件夹时的三个动作 ----
// 决定权（要不要问用户、问什么）属于界面，这里只提供事实和两种执行方式。

// 先看一眼那个文件夹里有没有数据
async function inspectConversationFolder() {
  if (!_folderBackend) return { hasData: false, count: 0, error: null };
  try {
    if (_folderBackend.ensurePermission) {
      const ok = await _folderBackend.ensurePermission();
      if (!ok) throw new Error("没有文件夹的读写权限");
    }
    const data = await _folderBackend.read();
    if (data && Array.isArray(data.sessions)) {
      return { hasData: data.sessions.length > 0, count: data.sessions.length, error: null };
    }
    return { hasData: false, count: 0, error: null };
  } catch (e) {
    return { hasData: false, count: 0, error: e };
  }
}

// 用文件夹里的数据替换内存里的
async function adoptFolderConversations() {
  const data = await _folderBackend.read();
  _folderBlocked = null;      // 用户明确选择了这个文件夹的内容，解锁
  if (data && Array.isArray(data.sessions)) {
    sessions = data.sessions;
    presets = Array.isArray(data.presets) ? data.presets : [];
    _clearStaleLocalCopy();
    return { source: "disk" };
  }
  return { source: "empty" };
}

// 把内存里的数据写进文件夹，并清掉本地那份过期副本
async function migrateIntoFolder() {
  _folderBlocked = null;      // 用户明确要求写入，解锁
  await _trackAsync(_writeConversations(), "sessions");
  _clearStaleLocalCopy();
  return { source: "migrated" };
}

// =====================================================================
// 8. 旧名字的薄壳（迁移期用）
// =====================================================================
// 保留 saveLocal / saveToDisk 这两个名字，内部全部委托到这里 ——
// 于是那 84 个调用点在改完之前就已经走在新路径上了。

// 旧 saveLocal()：历史上写 cfg+sessions+presets+drafts 四个键。
// 现在语义 = persistNow("all")：
//   home=local 的切片写本地存储（同步、失败同步抛出，importer 的 try/catch 照旧有效）
//   会话数据集写进它真正的家
// 这一步就地消灭了「流式期间只写 localStorage、磁盘一直落后」的问题。
function persistAllShim() {
  persistNow("all");
}

// 旧 saveToDisk()：只负责把会话数据集写到磁盘。
// 没绑文件夹时和以前一样是空操作 —— 旧版第一行就是 if(!folderHandle) return。
// 旧版从不抛异常，这里也保持：失败只进落盘状态。
function persistConversationsShim() {
  if (conversationsHome() !== "disk") return;
  try { _trackAsync(_writeConversations(), "sessions"); }
  catch (e) { _reportPersistError("sessions", e); }
}
