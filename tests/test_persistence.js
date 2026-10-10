// 持久化模块的行为测试。
//
// ★ 这个文件只加载 js/persistence.js 一个模块 —— 不启动整个应用、不模拟 DOM。
//   这正是「加深」的回报：模块够深，就能在自己的接缝上被单独测试。
//   对比 test_integration.js：它要造 200 行假浏览器才能跑第一条断言。
//
// 用法: node test_persistence.js <项目根目录>
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = process.argv[2] || path.dirname(__dirname);
const MODULE_PATH = path.join(ROOT, "js", "persistence.js");
const code = fs.readFileSync(MODULE_PATH, "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log("  [FAIL] " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

// ===================== 两个内存后端 =====================

function mkLocal() {
  const d = {};
  return {
    _d: d,
    writes: [],
    failOnKey: null,
    failError: null,
    kind: "local",
    getItem(k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
    setItem(k, v) {
      if (this.failOnKey && k === this.failOnKey) throw this.failError;
      this.writes.push(k);
      d[k] = String(v);
    },
    removeItem(k) { delete d[k]; },
    has(k) { return Object.prototype.hasOwnProperty.call(d, k); },
    countWrites(k) { return this.writes.filter(x => x === k).length; },
    clear() { Object.keys(d).forEach(k => delete d[k]); this.writes = []; },
  };
}

function mkFolder(initial) {
  const st = {
    exists: initial !== undefined && initial !== null,
    data: initial ? JSON.parse(JSON.stringify(initial)) : null,
    writes: 0,
    failRead: null,
    failWrite: null,
  };
  return {
    _st: st,
    kind: "folder",
    name: "测试文件夹",
    async ensurePermission() { return true; },
    async read() {
      if (st.failRead) throw st.failRead;
      return st.exists ? JSON.parse(JSON.stringify(st.data)) : null;
    },
    async write(payload) {
      if (st.failWrite) throw st.failWrite;
      st.writes++;
      st.exists = true;
      st.data = JSON.parse(JSON.stringify(payload));
    },
  };
}

const quotaErr = () => {
  const e = new Error("存储配额已满");
  e.name = "QuotaExceededError";
  e.code = 22;
  return e;
};

// ===================== 搭沙箱：只有这一个模块 =====================
const local = mkLocal();
const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  setTimeout, clearTimeout,
  localStorage: local,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map,
  isNaN, parseInt, parseFloat,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
// 模块要读写的全局量（这个项目没有模块系统，状态就是全局量）
vm.runInContext(
  "var cfg = {}; var sessions = []; var presets = []; var drafts = {};" +
  "var DEFAULT_CFG = { ragUrl: 'http://127.0.0.1:8000', num_predict: 1024, providers: [] };",
  sandbox
);
vm.runInContext(code, sandbox, { filename: MODULE_PATH });

function setG(name, val) { sandbox.__v = val; vm.runInContext(name + " = __v;", sandbox); }
function getG(name) { sandbox.__v = undefined; vm.runInContext("__v = " + name + ";", sandbox); return sandbox.__v; }
function ev(expr) { return vm.runInContext(expr, sandbox); }
function settle() { return new Promise(r => setTimeout(r, 0)); }

// 每个用例开始前把世界恢复干净。folder 通过 opts 传，避免上一个用例的文件夹漏网。
function reset(opts) {
  opts = opts || {};
  sandbox.__local = local;
  sandbox.__folder = opts.folder || null;   // 默认没绑文件夹
  local.clear();
  local.failOnKey = null;
  local.failError = null;
  setG("sessions", opts.sessions || []);
  setG("presets", opts.presets || []);
  setG("drafts", opts.drafts || {});
  setG("cfg", opts.cfg || {});
  ev("_pendingSlices = {};");
  ev("if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }");
  ev("_lastWriteAt = 0; _convInFlight = null; _convAgain = false; _folderBlocked = null;");
  ev("_persistSnap.ok = true; _persistSnap.lastError = null; _persistSnap.pending = []; _persistSnap.inFlight = []; _persistSnap.lastOkAt = 0;");
  ev("_persistListeners.length = 0;");
  ev("configurePersistence({ local: globalThis.__local, folder: globalThis.__folder });");
}

async function main() {

  // ===================== 1. 键名清单 =====================
  section("1. 键名清单是唯一事实");
  const KEY = ev("PERSIST_KEY");
  ok("清单存在", !!KEY);
  ok("cfg 键", KEY.cfg === "chat_cfg");
  ok("sessions 键", KEY.sessions === "chat_sessions");
  ok("presets 键", KEY.presets === "chat_presets");
  ok("drafts 键", KEY.drafts === "chat_drafts");
  ok("usage 键已登记（不再由 stats.js 私自定义）", KEY.usage === "chat_usage");
  ok("usageLog 键已登记", KEY.usageLog === "chat_usage_log");
  ok("stats 偏好键已登记（此前是硬编码字面量）", KEY.statsRange === "chat_stats_range" && KEY.statsGroup === "chat_stats_group");
  const values = Object.values(KEY);
  ok("没有两个键同名", new Set(values).size === values.length, values);
  ok("非 localStorage 位置也登记了", ev("PERSIST_DB.name") === "chat_db" && ev("PERSIST_FILE") === "conversations.json");

  // ===================== 2. 切片表 =====================
  section("2. 切片表：性格与住所");
  const SL = ev("PERSIST_SLICES");
  ok("cfg 住本地", SL.cfg.home === "local");
  ok("drafts 住本地", SL.drafts.home === "local");
  ok("sessions 属于会话数据集", SL.sessions.home === "conversations");
  ok("presets 属于会话数据集", SL.presets.home === "conversations");
  ok("会话数据集是 critical（写失败要让用户知道）", SL.sessions.weight === "critical" && SL.presets.weight === "critical");
  ok("草稿是 disposable（可以放弃）", SL.drafts.weight === "disposable");

  // ===================== 3. home = local =====================
  section("3. 没绑文件夹：会话数据集住本地存储");
  reset({ sessions: [{ id: "s1" }], presets: [{ id: "p1" }], drafts: { a: "x" }, cfg: { theme: "dark" } });
  ok("当前 home 是 local", ev("conversationsHome()") === "local");
  ok("落盘状态报告 home", sandbox.persistStatus().home === "local");
  sandbox.persistNow("all");
  ok("写了 cfg 键", local.has("chat_cfg"));
  ok("写了 sessions 键", local.has("chat_sessions"));
  ok("写了 presets 键", local.has("chat_presets"));
  ok("写了 drafts 键", local.has("chat_drafts"));
  ok("sessions 内容正确", JSON.parse(local.getItem("chat_sessions"))[0].id === "s1");

  // ===================== 4. home = disk =====================
  section("4. 绑了文件夹：会话数据集只住磁盘，本地不留副本");
  const f1 = mkFolder(null);
  reset({ sessions: [{ id: "s1" }], presets: [], drafts: {}, cfg: {}, folder: f1 });
  ok("当前 home 是 disk", ev("conversationsHome()") === "disk");
  sandbox.persistNow("all");
  await settle(); await settle();
  ok("磁盘收到数据", f1._st.exists && f1._st.data.sessions.length === 1);
  ok("磁盘 payload 带格式版本", f1._st.data.version === ev("PERSIST_FORMAT_VERSION"));
  ok("本地不再写 sessions（单一真值源）", !local.has("chat_sessions"), Object.keys(local._d));
  ok("本地不再写 presets", !local.has("chat_presets"));
  ok("cfg 仍然住本地（小数据不跟着搬）", local.has("chat_cfg"));

  // ===================== 5. loadConversations 的三种裁决 =====================
  section("5. 读取：谁说了算");

  // 5a 磁盘有数据 → 磁盘赢，本地过期副本清掉
  const f2 = mkFolder({ sessions: [{ id: "disk" }], presets: [{ id: "dp" }] });
  reset({ sessions: [{ id: "local-stale" }], folder: f2 });
  local.setItem("chat_sessions", JSON.stringify([{ id: "local-stale" }]));
  let r = await sandbox.loadConversations();
  ok("来源是磁盘", r.source === "disk", r.source);
  ok("内存被磁盘数据替换（磁盘永不落后，所以不再发生回滚）", getG("sessions")[0].id === "disk");
  ok("presets 也来自磁盘", getG("presets")[0].id === "dp");
  ok("本地过期副本被清掉", !local.has("chat_sessions") && !local.has("chat_presets"));

  // 5b 磁盘文件不存在 → 把内存里的搬进磁盘（老用户搬家路径）
  const f3 = mkFolder(null);
  reset({ sessions: [{ id: "from-local" }], presets: [], folder: f3 });
  r = await sandbox.loadConversations();
  ok("来源是迁移", r.source === "migrated", r.source);
  ok("数据被搬进磁盘", f3._st.exists && f3._st.data.sessions[0].id === "from-local");
  ok("搬完清掉本地副本", !local.has("chat_sessions"));

  // 5c 磁盘读不出来 → 明确报错，绝不清空（Q6(a) 的代价条款）
  const f4 = mkFolder(null);
  f4._st.failRead = new Error("权限被撤销");
  reset({ sessions: [{ id: "still-here" }], folder: f4 });
  local.setItem("chat_sessions", JSON.stringify([{ id: "still-here" }]));
  r = await sandbox.loadConversations();
  ok("来源是 disk-unreadable", r.source === "disk-unreadable", r.source);
  ok("内存那份没被清空（用户至少还能看到东西）", getG("sessions")[0].id === "still-here");
  ok("本地副本没被清掉（还有兜底）", local.has("chat_sessions"));
  ok("落盘状态如实标记为失败", sandbox.persistStatus().ok === false);
  ok("失败归到 critical", sandbox.persistStatus().lastError.weight === "critical");

  // 5d 读失败之后必须上锁：不许往这个文件夹写，否则会把空数据覆盖上去
  const f7 = mkFolder({ sessions: [{ id: "precious" }] });
  f7._st.failRead = new Error("权限被撤销");
  reset({ sessions: [], folder: f7 });
  await sandbox.loadConversations();
  f7._st.failRead = null;                 // 读能力恢复了，但这一轮没有再读
  sandbox.persistConversationsShim();
  await settle(); await settle();
  ok("读失败后拒绝写入（不会覆盖用户原有的对话）", !f7._st.writes, f7._st.writes);
  ok("原有数据还在", f7._st.data.sessions[0].id === "precious");
  ok("拒绝写入被记进落盘状态", sandbox.persistStatus().ok === false);

  sandbox.setFolderBackend(f7);           // 用户/程序明确重新信任它
  sandbox.persistConversationsShim();
  await settle(); await settle();
  ok("重新信任之后可以写入", f7._st.writes === 1, f7._st.writes);

  // ===================== 6. 节流合批 =====================
  section("6. 节流：热路径合批，关键动作立刻写");
  reset({ cfg: { fontSize: 15 } });
  sandbox.persist("cfg");                       // 距上次很久 → 立刻写
  ok("第一次 persist 立刻落盘", local.countWrites("chat_cfg") === 1, local.countWrites("chat_cfg"));
  setG("cfg", { fontSize: 16 });
  sandbox.persist("cfg");                       // 在节流窗口内 → 只能等着
  ok("第二次 persist 没有立刻写", local.countWrites("chat_cfg") === 1);
  ok("但被记成待写", sandbox.persistStatus().pending.indexOf("cfg") >= 0, sandbox.persistStatus().pending);
  sandbox.flushPersist();
  ok("flush 之后写下去了", local.countWrites("chat_cfg") >= 2, local.countWrites("chat_cfg"));
  ok("待写清空", sandbox.persistStatus().pending.length === 0);
  ok("内容是最新的", JSON.parse(local.getItem("chat_cfg")).fontSize === 16);

  // ===================== 7. persistNow 同步抛出 =====================
  section("7. 本地写失败必须同步抛出（importer 的契约）");
  reset({ cfg: {}, drafts: {} });
  local.failOnKey = "chat_cfg";
  local.failError = quotaErr();
  let threw = null;
  try { sandbox.persistNow("all"); } catch (e) { threw = e; }
  ok("persistNow 同步抛出了", !!threw);
  ok("抛的是配额错误本身（importer 靠它回滚）", threw && threw.name === "QuotaExceededError");
  ok("配额错误被记进落盘状态", sandbox.persistStatus().ok === false);

  // 对照：旧 saveDraft 语义是静默吞掉（storage.js 的薄壳负责 catch），
  // 这里验证「抛」是模块行为、「吞」由调用方决定。
  local.failOnKey = null;
  local.failError = null;

  // ===================== 8. 磁盘写失败的可见性 =====================
  section("8. 磁盘写失败不再无声");
  const f5 = mkFolder(null);
  reset({ sessions: [{ id: "s1" }], folder: f5 });
  f5._st.failWrite = new Error("磁盘已满");
  const seen = [];
  sandbox.onPersistStatus(s => seen.push(s));
  sandbox.persistConversationsShim();
  await settle(); await settle();
  ok("落盘状态变成失败", sandbox.persistStatus().ok === false);
  ok("失败切片是 sessions", sandbox.persistStatus().lastError.slice === "sessions");
  ok("归为 critical（不能放弃）", sandbox.persistStatus().lastError.weight === "critical");
  ok("订阅者收到了通知", seen.length > 0);
  ok("通知里带着失败事实", seen.some(s => s.lastError && s.lastError.message === "磁盘已满"));

  f5._st.failWrite = null;
  sandbox.retryPersist();
  await settle(); await settle();
  ok("重试之后恢复正常", sandbox.persistStatus().ok === true, sandbox.persistStatus());
  ok("数据真的写进去了", f5._st.exists && f5._st.data.sessions.length === 1);

  // ===================== 9. 薄壳语义 =====================
  section("9. 旧名字的薄壳");
  reset({ sessions: [{ id: "s1" }] });
  sandbox.persistConversationsShim();           // 旧 saveToDisk：没绑文件夹时是空操作
  await settle();
  ok("home=local 时 saveToDisk 是空操作（与旧版一致）", !local.has("chat_sessions"), Object.keys(local._d));

  const f6 = mkFolder(null);
  reset({ sessions: [{ id: "flush-me" }], folder: f6 });
  ok("flush 之前磁盘还没有数据", !f6._st.exists);
  sandbox.flushPersist();                        // 没有任何积压也要补写磁盘
  await settle(); await settle();
  ok("flushPersist 在没有积压时也补写磁盘", f6._st.exists && f6._st.data.sessions[0].id === "flush-me");

  // ===================== 10. 绑定文件夹的三种情况 =====================
  section("10. 绑定文件夹：有歧义才问");
  const fEmpty = mkFolder(null);
  reset({ folder: fEmpty });
  let info = await sandbox.inspectConversationFolder();
  ok("空文件夹：没有数据", info.hasData === false && info.count === 0);

  const fFull = mkFolder({ sessions: [{ id: "a" }, { id: "b" }], presets: [] });
  reset({ folder: fFull });
  info = await sandbox.inspectConversationFolder();
  ok("有数据的文件夹：报出数量", info.hasData === true && info.count === 2, info);

  reset({ sessions: [{ id: "mine" }], folder: fFull });
  await sandbox.adoptFolderConversations();
  ok("选择「用文件夹的替换」→ 内存被替换", getG("sessions").length === 2 && getG("sessions")[0].id === "a");

  const fFull2 = mkFolder({ sessions: [{ id: "theirs" }], presets: [] });
  reset({ sessions: [{ id: "mine" }], folder: fFull2 });
  await sandbox.migrateIntoFolder();
  ok("选择「把当前的写进去」→ 磁盘被覆盖", fFull2._st.data.sessions[0].id === "mine");
  ok("同时清掉本地过期副本", !local.has("chat_sessions"));

  const fBad = mkFolder(null);
  fBad._st.failRead = new Error("读不了");
  reset({ folder: fBad });
  info = await sandbox.inspectConversationFolder();
  ok("读不出来的文件夹：如实报告错误，不假装是空的", !!info.error && info.hasData === false);

  // ===================== 11. 静态约束（防止键名清单烂掉） =====================
  section("11. 静态检查：键名没有回流到别处");
  const cfgJs = fs.readFileSync(path.join(ROOT, "js", "config.js"), "utf8");
  const storageJs = fs.readFileSync(path.join(ROOT, "js", "storage.js"), "utf8");
  const statsJs = fs.readFileSync(path.join(ROOT, "js", "features", "stats.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  ok("config.js 不再硬编码 chat_ 键名", !/["']chat_(cfg|sessions|presets|drafts)["']/.test(cfgJs));
  ok("storage.js 不再硬编码 chat_ 键名", !/["']chat_(cfg|sessions|presets|drafts)["']/.test(storageJs));
  ok("stats.js 不再硬编码 usage 键名", !/["']chat_usage(_log)?["']/.test(statsJs));
  ok("stats.js 不再硬编码 stats 偏好键名", !/["']chat_stats_(range|group)["']/.test(statsJs));
  ok("stats.js 的键取自清单", /PERSIST_KEY\.usageLog/.test(statsJs) && /PERSIST_KEY\.statsRange/.test(statsJs));
  ok("storage.js 不再硬编码 IndexedDB 名字", !/["']folderHandle["']/.test(storageJs));
  ok("config.js 的 saveLocal 已变成薄壳", /function saveLocal\(\)\s*\{\s*persistAllShim\(\);/.test(cfgJs));
  ok("index.html 在 config.js 之前加载 persistence.js",
     html.indexOf("js/persistence.js") > 0 && html.indexOf("js/persistence.js") < html.indexOf("js/config.js"));
  ok("index.html 里的 js 模块从 18 个变成 19 个",
     (html.match(/<script\s+src="js\//g) || []).length === 19,
     (html.match(/<script\s+src="js\//g) || []).length);

  // ===================== 汇总 =====================
  console.log("");
  console.log("-".repeat(56));
  console.log("断言: " + (pass + fail) + "   通过: " + pass + "   失败: " + fail);
  if (fail) {
    console.log("失败项:");
    failures.forEach(f => console.log("  - " + f));
    process.exit(1);
  }
  console.log("PERSISTENCE SUITE PASSED");
}

main().catch(e => { console.error("测试自身异常:", e); process.exit(1); });
