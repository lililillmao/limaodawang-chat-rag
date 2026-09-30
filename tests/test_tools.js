// tools.js + api.js 工具调用辅助函数的实测。
// 用法: node test_tools.js <tools.js 路径> <api.js 路径>
const fs = require("fs");
const vm = require("vm");

const toolsPath = process.argv[2];
const apiPath = process.argv[3];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// ---------- 桩环境 ----------
const els = {};
function mkEl(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", checked: false, style: {}, dataset: {}, files: [],
    options: [], classList: { _s: new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)} },
    querySelector: () => null, querySelectorAll: () => [], appendChild(){}, closest(){return null},
    setAttribute(){}, getAttribute(){return null}, addEventListener(){}
  };
}
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { getElementById: id => els[id] || (els[id] = mkEl(id)), querySelector: () => null, querySelectorAll: () => [], createElement: t => mkEl(t), addEventListener(){} },
  window: {}, navigator: {},
  localStorage: { _d:{}, getItem(k){return k in this._d?this._d[k]:null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} },
  alert(){}, confirm(){return true}, Blob: function(){}, URL:{createObjectURL:()=>"b",revokeObjectURL(){}},
  TextEncoder, TextDecoder, fetch: null,
  escapeHtml: s => String(s), setStatus(){}, saveLocal(){}, saveToDisk(){}, loadLocal(){},
  renderSessions(){}, renderMessages(){}, renderPresets(){}, restoreDraft(){},
  getCurrentSession: () => ({ id:"s1", title:"测试", messages:[] }),
  createSession: () => ({ id:"s1", title:"t", messages:[] }),
  formatTime: () => "", estimateTokens: t => t ? t.length : 0,
  getRagUrl: () => "http://127.0.0.1:8000",
  getCurrentProvider: () => ({ id:"ollama", type:"ollama", name:"本地 Ollama" }),
  currentSkillIds: [], currentSkillScope: "self", currentSkillName: "", skillMetaCache: {},
  cfg: { providers: [{ id:"ollama", type:"ollama", name:"本地 Ollama" }], model:"qwen2.5:7b" },
  resolveOpenAIEndpoint: null, toTokenNum: v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
};
sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext("var sessions = [];", sb);
// Skill 下拉框内容
els.skillSelect = mkEl("skillSelect");
els.skillSelect.options = [ { value:"", text:"（未加载Skill）" }, { value:"__combo__", text:"组合" }, { value:"limao", text:"狸猫" } ];
sb.skillMetaCache = { limao: { id:"limao", name:"狸猫", prompt:"x", emoji:{}, scope:"self" } };

// 加载 tools.js（只取其中函数，api.js 的两个纯函数单独抽取）
const toolsCode = fs.readFileSync(toolsPath, "utf8");
const apiCode = fs.readFileSync(apiPath, "utf8");

// api.js 无法整体在 vm 里跑（大量 DOM/fetch 依赖），只抽取三个纯函数
function extractFn(src, name) {
  const re = new RegExp("^function " + name + "\\s*\\([\\s\\S]*?\\n\\}", "m");
  const m = src.match(re);
  if (!m) throw new Error("抽取失败: " + name);
  return m[0];
}
const pureHelpers = ["accumulateToolCalls", "normalizeToolCalls", "buildMultimodalUserMessage"]
  .map(n => extractFn(apiCode, n)).join("\n\n");

const prelude = pureHelpers + "\n";
vm.runInContext(prelude + toolsCode, sb, { filename: toolsPath });

const T = vm.runInContext("({ TOOLS_REGISTRY, getToolSchemas, getToolByName, getToolDisplayName, parseToolArguments, executeToolCall, toolResultToText, toolSafeEval, toolCalculator, toolGetCurrentTime, toolListSkills, toolGetSessionInfo, setToolRoundStatus })", sb);
const H = vm.runInContext("({ accumulateToolCalls, normalizeToolCalls, buildMultimodalUserMessage })", sb);

console.log("\n=== 1. 工具注册表 ===");
ok("注册了 5 个工具", T.TOOLS_REGISTRY.length === 5, T.TOOLS_REGISTRY.length);
ok("每个工具都有 name/description/parameters/run",
  T.TOOLS_REGISTRY.every(t => t.name && t.description && t.parameters && typeof t.run === "function"));
ok("全部标记 readOnly", T.TOOLS_REGISTRY.every(t => t.readOnly === true));
ok("工具名唯一", new Set(T.TOOLS_REGISTRY.map(t => t.name)).size === T.TOOLS_REGISTRY.length);
ok("getToolByName 命中", !!T.getToolByName("calculator"));
ok("getToolByName 未命中返回 null", T.getToolByName("nope") === null);
ok("显示名可读", T.getToolDisplayName("calculator") === "计算器", T.getToolDisplayName("calculator"));
ok("未知工具显示名回落到原名", T.getToolDisplayName("zzz") === "zzz");

console.log("\n=== 2. getToolSchemas 只暴露安全字段 ===");
const schemas = T.getToolSchemas();
ok("schema 数量一致", schemas.length === 5, schemas.length);
ok("每个都是 type:function", schemas.every(s => s.type === "function"));
ok("不泄漏 run/readOnly/label",
  schemas.every(s => !("run" in s.function) && !("readOnly" in s.function) && !("label" in s.function)));
ok("calculator 的 expression 是必填", JSON.stringify(schemas.find(s => s.function.name === "calculator").function.parameters.required) === JSON.stringify(["expression"]));
ok("rag_search 的 query 是必填", JSON.stringify(schemas.find(s => s.function.name === "rag_search").function.parameters.required) === JSON.stringify(["query"]));

console.log("\n=== 3. parseToolArguments 容错 ===");
ok("正常 JSON", JSON.stringify(T.parseToolArguments('{"query":"猫"}')) === '{"query":"猫"}');
ok("空字符串 → {}", JSON.stringify(T.parseToolArguments("")) === "{}");
ok("null → {}", JSON.stringify(T.parseToolArguments(null)) === "{}");
ok("纯空白 → {}", JSON.stringify(T.parseToolArguments("   ")) === "{}");
ok("剥掉 ```json 围栏", JSON.stringify(T.parseToolArguments('```json\n{"a":1}\n```')) === '{"a":1}');
ok("剥掉 ``` 围栏（无语言标注）", JSON.stringify(T.parseToolArguments('```\n{"a":2}\n```')) === '{"a":2}');
ok("前后有噪声时截取花括号", JSON.stringify(T.parseToolArguments('hello {"a":3} world')) === '{"a":3}');
const broken = T.parseToolArguments('{"a": ');
ok("截断 JSON 标记 __parse_error", broken.__parse_error === true, broken);
const arr = T.parseToolArguments('[1,2]');
ok("数组被包成 {value:[...]}", Array.isArray(arr.value) && arr.value.length === 2, arr);

console.log("\n=== 4. 计算器（安全求值） ===");
ok("加减乘除", T.toolSafeEval("1+2*3-4/2") === 5, T.toolSafeEval("1+2*3-4/2"));
ok("括号优先级", T.toolSafeEval("(1+2)*3") === 9);
ok("乘方 ^", T.toolSafeEval("2^10") === 1024);
ok("乘方 **", T.toolSafeEval("2**8") === 256);
ok("取模", T.toolSafeEval("10%3") === 1);
ok("一元负号", T.toolSafeEval("-5+3") === -2, T.toolSafeEval("-5+3"));
ok("小数", T.toolSafeEval("0.5*4") === 2);
ok("全角逗号被忽略", T.toolSafeEval("1,000+1") === 1001);
ok("× ÷ 被规范化", T.toolSafeEval("6×7") === 42, T.toolSafeEval("6×7"));
ok("嵌套括号", T.toolSafeEval("((2+3)*(4-1))") === 15, T.toolSafeEval("((2+3)*(4-1))"));

function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
ok("拒绝字母（注入防护）", throws(() => T.toolSafeEval("process.exit(1)")));
ok("拒绝分号与语句", throws(() => T.toolSafeEval("1;2")));
ok("拒绝单引号字符串", throws(() => T.toolSafeEval("'a'")));
ok("拒绝方括号", throws(() => T.toolSafeEval("this[0]")));
ok("拒绝反引号", throws(() => T.toolSafeEval("`x`")));
ok("除以零被拦截", throws(() => T.toolSafeEval("1/0")));
ok("对零取模被拦截", throws(() => T.toolSafeEval("1%0")));
ok("括号不匹配被拦截", throws(() => T.toolSafeEval("(1+2")));
ok("空表达式被拦截", throws(() => T.toolSafeEval("")));
ok("超长表达式被拦截", throws(() => T.toolSafeEval("1+".repeat(150) + "1")));
ok("表达式意外结束被拦截", throws(() => T.toolSafeEval("1+")));

console.log("\n=== 5. 具体工具执行 ===");
const t0 = T.toolGetCurrentTime({});
ok("时间工具 ok", t0.ok === true);
ok("时间文本含年份", /\d{4}-\d{2}-\d{2}/.test(t0.text), t0.text);
ok("时间 data 有 iso", typeof t0.data.iso === "string");
const c0 = T.toolCalculator({ expression: "12*12" });
ok("计算器返回结果", c0.ok && c0.data.value === 144, c0.data);
ok("计算器文本含等号", c0.text.includes("="), c0.text);
const c1 = T.toolCalculator({ expr: "7+8" });
ok("兼容 expr 参数别名", c1.data.value === 15, c1.data);
const ls = T.toolListSkills({});
ok("列出 Skill ok", ls.ok === true);
ok("列出 1 个真实 Skill", ls.data.skills.length === 1, ls.data.skills);
ok("Skill 文本含名字", ls.text.includes("狸猫"), ls.text);
const si = T.toolGetSessionInfo({});
ok("会话信息 ok", si.ok === true);
ok("会话信息含模型名", si.text.includes("qwen2.5:7b"), si.text);

console.log("\n=== 6. executeToolCall 永不抛异常 ===");
(async () => {
  const r1 = await T.executeToolCall({ function: { name: "calculator", arguments: '{"expression":"2+2"}' } });
  ok("正常调用 ok", r1.ok === true && r1.data.value === 4, r1.data);
  ok("带耗时字段 ms", typeof r1.ms === "number" && r1.ms >= 0);

  const r2 = await T.executeToolCall({ function: { name: "nope", arguments: "{}" } });
  ok("未知工具 → ok:false", r2.ok === false);
  ok("未知工具提示可用清单", r2.text.includes("calculator"), r2.text);

  const r3 = await T.executeToolCall({ function: { name: "calculator", arguments: "{bad json" } });
  ok("坏 JSON → ok:false 不抛", r3.ok === false, r3);

  const r4 = await T.executeToolCall({ function: { name: "calculator", arguments: '{"expression":"abc"}' } });
  ok("非法表达式 → ok:false 不抛", r4.ok === false, r4.text);

  const r5 = await T.executeToolCall({ function: { name: "calculator" } });
  ok("缺 arguments 不抛", typeof r5.ok === "boolean", r5);
  const r6 = await T.executeToolCall(null);
  ok("null 调用不抛", r6.ok === false);
  const r7 = await T.executeToolCall({});
  ok("空对象不抛", r7.ok === false);

  const long = T.toolResultToText({ text: "x".repeat(9000) });
  ok("超长结果被截断", long.length < 4200, long.length);
  ok("截断有提示", long.includes("截断"));

  console.log("\n=== 7. 工具调用增量拼接（OpenAI 分片） ===");
  let acc = [];
  // 真实 OpenAI 形态：第一片只有 name 和 id，后续片只有 arguments 片段
  acc = H.accumulateToolCalls(acc, [{ index: 0, id: "call_1", type: "function", function: { name: "rag_", arguments: "" } }]);
  acc = H.accumulateToolCalls(acc, [{ index: 0, function: { arguments: '{"que' } }]);
  acc = H.accumulateToolCalls(acc, [{ index: 0, function: { arguments: 'ry":"猫"}' } }]);
  const norm = H.normalizeToolCalls(acc);
  ok("拼出完整 arguments", norm[0].function.arguments === '{"query":"猫"}', norm[0].function.arguments);
  ok("保留 id", norm[0].id === "call_1", norm[0].id);
  ok("name 不重复累加", norm[0].function.name === "rag_", norm[0].function.name);

  // name 分片是真实存在的：必须拼成完整名字
  let acc2 = [];
  acc2 = H.accumulateToolCalls(acc2, [{ index: 0, function: { name: "calc", arguments: "" } }]);
  acc2 = H.accumulateToolCalls(acc2, [{ index: 0, function: { name: "ulator", arguments: "{}" } }]);
  ok("分段 name 被正确拼接", H.normalizeToolCalls(acc2)[0].function.name === "calculator", H.normalizeToolCalls(acc2)[0].function.name);

  // 三段式分片（真实 OpenAI 可能是更多段）
  let acc2b = [];
  acc2b = H.accumulateToolCalls(acc2b, [{ index: 0, function: { name: "get_", arguments: "" } }]);
  acc2b = H.accumulateToolCalls(acc2b, [{ index: 0, function: { name: "current", arguments: "" } }]);
  acc2b = H.accumulateToolCalls(acc2b, [{ index: 0, function: { name: "_time", arguments: "{}" } }]);
  ok("三段式 name 拼接正确", H.normalizeToolCalls(acc2b)[0].function.name === "get_current_time", H.normalizeToolCalls(acc2b)[0].function.name);

  // 完整名字重复推送（Ollama / 部分网关）不能拼成 rag_searchrag_search
  let acc3 = [];
  acc3 = H.accumulateToolCalls(acc3, [{ index: 0, function: { name: "rag_search", arguments: "" } }]);
  acc3 = H.accumulateToolCalls(acc3, [{ index: 0, function: { name: "rag_search", arguments: "{}" } }]);
  ok("重复完整 name 不重复累加", H.normalizeToolCalls(acc3)[0].function.name === "rag_search", H.normalizeToolCalls(acc3)[0].function.name);

  // 先收到一个短片段，再收到完整名字（应采纳完整的）
  let acc3b = [];
  acc3b = H.accumulateToolCalls(acc3b, [{ index: 0, function: { name: "rag", arguments: "" } }]);
  acc3b = H.accumulateToolCalls(acc3b, [{ index: 0, function: { name: "rag_search", arguments: "{}" } }]);
  ok("短片段后补完整名 → 采纳完整名", H.normalizeToolCalls(acc3b)[0].function.name === "rag_search", H.normalizeToolCalls(acc3b)[0].function.name);

  // 多工具并行
  let acc4 = [];
  acc4 = H.accumulateToolCalls(acc4, [
    { index: 0, id: "c0", function: { name: "calculator", arguments: '{"ex' } },
    { index: 1, id: "c1", function: { name: "get_current_time", arguments: "" } }
  ]);
  acc4 = H.accumulateToolCalls(acc4, [{ index: 0, function: { arguments: 'pression":"1+1"}' } }]);
  const n4 = H.normalizeToolCalls(acc4);
  ok("多工具各自归位", n4.length === 2, n4.length);
  ok("工具 0 参数完整", n4[0].function.arguments === '{"expression":"1+1"}', n4[0].function.arguments);
  ok("工具 1 名字正确", n4[1].function.name === "get_current_time", n4[1].function.name);

  ok("normalizeToolCalls(undefined) → []", H.normalizeToolCalls(undefined).length === 0);
  ok("accumulateToolCalls(null, null) 不抛", Array.isArray(H.accumulateToolCalls(null, null)));
  ok("没有 name 的调用被过滤", H.normalizeToolCalls([{ index: 0, function: { arguments: "{}" } }]).length === 0);

  console.log("\n=== 8. 多模态消息体 ===");
  const imgs = [{ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA", b64: "AAAA" }];
  const om = H.buildMultimodalUserMessage("看图", imgs, "ollama");
  ok("Ollama 用 images 数组", Array.isArray(om.images) && om.images[0] === "AAAA", om);
  ok("Ollama content 是纯文本", om.content === "看图", om.content);
  ok("Ollama 不带 data: 前缀", !om.images[0].startsWith("data:"), om.images[0]);

  const oa = H.buildMultimodalUserMessage("看图", imgs, "openai");
  ok("OpenAI content 是数组", Array.isArray(oa.content), typeof oa.content);
  ok("OpenAI 第一项是 text", oa.content[0].type === "text" && oa.content[0].text === "看图", oa.content[0]);
  ok("OpenAI 第二项是 image_url", oa.content[1].type === "image_url" && oa.content[1].image_url.url === imgs[0].dataUrl, oa.content[1]);
  ok("OpenAI 不产生 images 字段", oa.images === undefined);

  const noImg = H.buildMultimodalUserMessage("纯文本", [], "ollama");
  ok("无图片时退化成普通文本消息", noImg.content === "纯文本" && noImg.images === undefined, noImg);

  console.log("\n" + "=".repeat(50));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
