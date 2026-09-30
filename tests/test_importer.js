// 用 vm 沙箱加载项目里的 importer.js，用假数据实测解析正确性。
// 用法: node test_importer.js <importer.js 路径>
const fs = require("fs");
const vm = require("vm");
const path = process.argv[2];

const code = fs.readFileSync(path, "utf8");

// ---- 最小 DOM / 全局桩 ----
const elements = {};
function mkEl(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", checked: false, style: {},
    dataset: {}, files: [],
    classList: { _s: new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)}, toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c)} },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(){}, closest(){return null}, click(){ this._clicked = true },
    setAttribute(){}, getAttribute(){return null}, addEventListener(){}
  };
}
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    getElementById: (id) => { if (!elements[id]) elements[id] = mkEl(id); return elements[id]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t) => mkEl("_" + t),
    addEventListener(){}
  },
  window: {},
  navigator: { storage: { estimate: async () => ({ usage: 0, quota: 5 * 1024 * 1024 }) } },
  localStorage: {
    _d: {},
    getItem(k){ return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v){ this._d[k] = String(v) },
    removeItem(k){ delete this._d[k] }
  },
  alert: () => {},
  confirm: () => true,
  Blob: function(){},
  URL: { createObjectURL: () => "blob:x", revokeObjectURL(){} },
  TextEncoder, TextDecoder,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map, isNaN, parseInt, parseFloat,
  // 项目内既有函数的最简实现
  escapeHtml: (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])),
  setStatus: () => {},
  saveLocal: () => {},
  saveToDisk: () => {},
  loadLocal: () => {},
  renderSessions: () => {},
  renderMessages: () => {},
  renderPresets: () => {},
  restoreDraft: () => {},
  getCurrentSession: () => null,
  createSession: () => ({ id: "s1", title: "t", messages: [] }),
  formatTime: () => "",
  cfg: { providers: [] }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// sessions 是全局 let，需要在同一作用域可写
vm.createContext(sandbox);
vm.runInContext("var sessions = []; globalThis.sessions = sessions;", sandbox);
vm.runInContext(code, sandbox, { filename: path });

const { detectImportFormat, convertImported } = sandbox.window.LimaoImport;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// ===================== ChatGPT 夹具 =====================
// 故意做成：树有分叉 + create_time 是秒 + parts 混入图片 part + 一条 system 消息
const chatgpt = [{
  title: "ChatGPT 测试会话",
  create_time: 1700000000.5,          // 秒
  update_time: 1700000100.5,
  current_node: "n4",
  mapping: {
    n0: { id: "n0", parent: null, children: ["n1"], message: { author: { role: "system" }, content: { content_type: "text", parts: ["你是一个助手"] }, create_time: 1700000000 } },
    n1: { id: "n1", parent: "n0", children: ["n2"], message: { author: { role: "user" }, content: { content_type: "text", parts: ["你好，第一句"] }, create_time: 1700000010 } },
    n2: { id: "n2", parent: "n1", children: ["n3", "nX"], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["你好！我是助手"] }, create_time: 1700000020 } },
    // 分叉支路：current_node 不走这里，应当被排除
    nX: { id: "nX", parent: "n2", children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["这条不该被导入"] }, create_time: 1700000099 } },
    n3: { id: "n3", parent: "n2", children: ["n4"], message: { author: { role: "user" }, content: { content_type: "multimodal_text", parts: ["看这张图", { content_type: "image_asset_pointer", asset_pointer: "file-service://abc" }] }, create_time: 1700000030 } },
    n4: { id: "n4", parent: "n3", children: [], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["我看到了"] }, create_time: 1700000040 } }
  }
}];

console.log("\n=== 1. ChatGPT 格式识别与解析 ===");
ok("识别为 chatgpt", detectImportFormat(chatgpt) === "chatgpt", detectImportFormat(chatgpt));
const cg = convertImported(chatgpt, "chatgpt");
ok("转出 1 个会话", cg.sessions.length === 1, cg.sessions.length);
const cgS = cg.sessions[0];
ok("会话有 id", !!cgS.id);
ok("标题正确", cgS.title === "ChatGPT 测试会话", cgS.title);
ok("pinned 为 false", cgS.pinned === false, cgS.pinned);

const roles = cgS.messages.map(m => m.role);
ok("system 消息被跳过", !roles.includes("system"), roles);
ok("消息序列为 user/assistant/user/assistant", JSON.stringify(roles) === JSON.stringify(["user", "assistant", "user", "assistant"]), roles);
ok("分叉支路未被导入", !cgS.messages.some(m => (m.content || "").includes("不该被导入")), cgS.messages.map(m => m.content));
ok("多模态文本保留了文字", (cgS.messages[2].content || "").includes("看这张图"), cgS.messages[2].content);
ok("create_time 秒 ×1000（毫秒）", cgS.messages[0].time === 1700000010000, cgS.messages[0].time);
ok("所有 time 都是毫秒级", cgS.messages.every(m => m.time > 1e12), cgS.messages.map(m => m.time));
ok("updatedAt 是毫秒", cgS.updatedAt > 1e12, cgS.updatedAt);
ok("createdAt 是毫秒", cgS.createdAt > 1e12, cgS.createdAt);
ok("消息数 = 4", cgS.messages.length === 4, cgS.messages.length);
ok("assistant 消息带 thinking 字段", typeof cgS.messages[1].thinking === "string", cgS.messages[1].thinking);

// ---- 环检测：mapping 成环不能死循环 ----
console.log("\n=== 2. ChatGPT 成环保护 ===");
const cyclic = [{
  title: "成环", create_time: 1700000000, current_node: "a",
  mapping: {
    a: { id: "a", parent: "b", children: ["b"], message: { author: { role: "user" }, content: { parts: ["A"] }, create_time: 1700000000 } },
    b: { id: "b", parent: "a", children: ["a"], message: { author: { role: "assistant" }, content: { parts: ["B"] }, create_time: 1700000001 } }
  }
}];
let cyclicOk = true, cycRes = null;
try { cycRes = convertImported(cyclic, "chatgpt"); } catch (e) { cyclicOk = false; }
ok("成环不抛异常且能返回", cyclicOk && cycRes && cycRes.sessions.length === 1, cycRes && cycRes.sessions.length);
ok("成环会话消息数有限（<=3）", cycRes && cycRes.sessions[0].messages.length <= 3, cycRes && cycRes.sessions[0].messages.length);

// ---- current_node 缺失时的兜底 ----
console.log("\n=== 3. ChatGPT current_node 缺失兜底 ===");
const noNode = [{ title: "缺 current_node", create_time: 1700000000, mapping: chatgpt[0].mapping }];
const nn = convertImported(noNode, "chatgpt");
ok("缺 current_node 仍能产出会话", nn.sessions.length === 1, nn.sessions.length);
ok("缺 current_node 仍有序消息", nn.sessions[0] && nn.sessions[0].messages.length >= 3, nn.sessions[0] && nn.sessions[0].messages.length);

// ===================== Claude 夹具 =====================
console.log("\n=== 4. Claude 格式识别与解析 ===");
const claude = [{
  uuid: "u1", name: "Claude 测试会话",
  created_at: "2025-01-02T03:04:05.000Z",
  updated_at: "2025-01-02T04:05:06.000Z",
  chat_messages: [
    { uuid: "m1", sender: "human", text: "Claude 你好", created_at: "2025-01-02T03:04:05.000Z", content: [{ type: "text", text: "Claude 你好" }] },
    { uuid: "m2", sender: "assistant", text: "", created_at: "2025-01-02T03:05:00.000Z", content: [{ type: "thinking", thinking: "让我想想" }, { type: "text", text: "你好，我是 Claude" }] },
    { uuid: "m3", sender: "human", text: "第二个问题", created_at: "2025-01-02T03:06:00.000Z", content: [{ type: "text", text: "第二个问题" }] }
  ]
}];
ok("识别为 claude", detectImportFormat(claude) === "claude", detectImportFormat(claude));
const cl = convertImported(claude, "claude");
ok("转出 1 个会话", cl.sessions.length === 1, cl.sessions.length);
const clS = cl.sessions[0];
ok("标题正确", clS.title === "Claude 测试会话", clS.title);
ok("human→user, assistant→assistant", JSON.stringify(clS.messages.map(m => m.role)) === JSON.stringify(["user", "assistant", "user"]), clS.messages.map(m => m.role));
ok("ISO 时间解析为毫秒", clS.messages[0].time === Date.parse("2025-01-02T03:04:05.000Z"), clS.messages[0].time);
ok("text 为空时回退到 content 文本", (clS.messages[1].content || "").includes("我是 Claude"), clS.messages[1].content);
ok("thinking part 被放进 thinking", (clS.messages[1].thinking || "").includes("让我想想"), clS.messages[1].thinking);

// ---- Claude 时间是数字（秒 / 毫秒） ----
console.log("\n=== 5. Claude 数字时间兼容 ===");
const clNum = [{ uuid: "u2", name: "数字时间", created_at: 1700000000, chat_messages: [
  { sender: "human", text: "秒级", created_at: 1700000000 },
  { sender: "assistant", text: "毫秒级", created_at: 1700000000000 }
]}];
const cln = convertImported(clNum, "claude");
ok("秒级数字被 ×1000", cln.sessions[0].messages[0].time === 1700000000000, cln.sessions[0].messages[0].time);
ok("毫秒级数字保持不变", cln.sessions[0].messages[1].time === 1700000000000, cln.sessions[0].messages[1].time);

// ===================== 边界情况 =====================
console.log("\n=== 6. 空会话 / 脏数据 / 格式识别 ===");
ok("本项目备份格式识别为 limao", detectImportFormat({ sessions: [] }) === "limao");
ok("垃圾数据识别为 unknown", detectImportFormat([{ foo: 1 }]) === "unknown", detectImportFormat([{ foo: 1 }]));
ok("null 识别为 unknown", detectImportFormat(null) === "unknown");
const emptySess = [{ title: "空会话", mapping: { n1: { id: "n1", parent: null, children: [], message: { author: { role: "user" }, content: { parts: [] }, create_time: 1 } } } }];
const es = convertImported(emptySess, "chatgpt");
ok("空会话被跳过", es.sessions.length === 0, es.sessions.length);
ok("空会话记入 skipped", es.skipped && es.skipped.length === 1, es.skipped && es.skipped.length);
const noTitle = [{ mapping: chatgpt[0].mapping, create_time: 1700000000 }];
const nt = convertImported(noTitle, "chatgpt");
ok("无标题时用首条用户消息兜底", nt.sessions[0] && nt.sessions[0].title.length > 0 && nt.sessions[0].title !== "null", nt.sessions[0] && nt.sessions[0].title);

console.log("\n=== 7. ChatGPT 隐藏消息应被过滤 ===");
const hiddenFixture = [{
  title: "含隐藏消息", create_time: 1700000000, current_node: "h3",
  mapping: {
    h1: { id: "h1", parent: null, children: ["h2"], message: { author: { role: "user" }, content: { parts: ["正常问题"] }, create_time: 1700000000 } },
    h2: { id: "h2", parent: "h1", children: ["h3"], message: { author: { role: "assistant" }, content: { parts: ["这条是隐藏的"] }, create_time: 1700000010, metadata: { is_visually_hidden_from_conversation: true } } },
    h3: { id: "h3", parent: "h2", children: [], message: { author: { role: "assistant" }, content: { parts: ["正常回答"] }, create_time: 1700000020 } }
  }
}];
const hd = convertImported(hiddenFixture, "chatgpt");
ok("隐藏消息被过滤掉", hd.sessions.length === 1 && !hd.sessions[0].messages.some(m => (m.content || "").includes("隐藏的")), hd.sessions[0] && hd.sessions[0].messages.map(m => m.content));
ok("正常消息仍保留", hd.sessions[0] && hd.sessions[0].messages.length === 2, hd.sessions[0] && hd.sessions[0].messages.length);

console.log("\n" + "=".repeat(50));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
