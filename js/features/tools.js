// ============ 工具调用（function calling） ============
// 1.23 新增。
//
// 设计原则：
//   1. 工具全部在浏览器端本地执行，不经过 Python 后端，避免引入新的鉴权面。
//   2. 只注册只读 / 无副作用的工具。任何写文件、执行命令类的能力一律不做，
//      因为模型输出不可信，这个项目又没有后端鉴权。
//   3. 不依赖任何外部库，全部原生实现。

// ============ 工具实现 ============

// 读取当前时间（模型本身无法知道"现在几点"）
function toolGetCurrentTime(args) {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const text = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
               `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
               `星期${week}`;
  return { ok: true, text, data: { iso: now.toISOString(), local: text } };
}

// 一个安全的小型四则运算求值器。
// 出于安全考虑刻意不使用 eval / new Function —— 模型给的字符串是不可信输入。
function toolSafeEval(expr) {
  const src = String(expr || "").replace(/[，,]/g, "").replace(/×/g, "*").replace(/÷/g, "/").trim();
  if (!src) throw new Error("表达式为空");
  if (src.length > 200) throw new Error("表达式过长");
  if (!/^[0-9+\-*/%().\s^]+$/.test(src)) throw new Error("表达式含有不被允许的字符，只支持数字与 + - * / % ( ) ^");

  const tokens = src.match(/\d+(?:\.\d+)?|\*\*|[+\-*/%()^]/g);
  if (!tokens) throw new Error("无法解析表达式");
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (t) => { if (tokens[pos] === t) { pos++; return true; } return false; };

  // 递归下降：expr → term (('+'|'-') term)*
  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (eat("+")) v += parseTerm();
      else if (eat("-")) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (eat("*")) v *= parseUnary();
      else if (eat("/")) { const d = parseUnary(); if (d === 0) throw new Error("除以零"); v /= d; }
      else if (eat("%")) { const d = parseUnary(); if (d === 0) throw new Error("对零取模"); v %= d; }
      else return v;
    }
  }
  function parseUnary() {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (eat("^") || eat("**")) return Math.pow(base, parseUnary());
    return base;
  }
  function parseAtom() {
    if (eat("(")) {
      const v = parseExpr();
      if (!eat(")")) throw new Error("括号不匹配");
      return v;
    }
    const t = peek();
    if (t == null) throw new Error("表达式意外结束");
    if (!/^\d/.test(t)) throw new Error("期望一个数字，却读到 " + t);
    pos++;
    return parseFloat(t);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("表达式在 " + tokens[pos] + " 附近无法解析");
  if (!Number.isFinite(result)) throw new Error("计算结果不是有限数");
  return result;
}

function toolCalculator(args) {
  const raw = (args && (args.expression || args.expr)) || "";
  const value = toolSafeEval(raw);
  const pretty = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
  return { ok: true, text: `${raw} = ${pretty}`, data: { expression: raw, value } };
}

// 检索本地知识库（复用已有的 RAG 后端）
async function toolRagSearch(args) {
  const query = (args && args.query) || "";
  if (!query.trim()) return { ok: false, text: "错误：query 不能为空" };
  let topK = parseInt(args && args.top_k, 10);
  if (!Number.isFinite(topK)) topK = 4;
  topK = Math.max(1, Math.min(10, topK));

  try {
    const params = new URLSearchParams({ query, top_k: topK });
    if (currentSkillIds.length === 1 && currentSkillScope === "self") {
      params.set("skill_id", currentSkillIds[0]);
      params.set("scope", "self");
    } else {
      params.set("scope", "all");
    }
    const res = await fetch(`${getRagUrl()}/api/search?${params.toString()}`);
    if (!res.ok) return { ok: false, text: `检索失败：HTTP ${res.status}` };
    const data = await res.json();
    const results = (data && data.results) || [];
    if (!results.length) return { ok: true, text: "知识库中没有找到相关内容。", data: { results: [] } };

    const lines = results.map((r, i) => {
      const dist = (r.distance != null) ? Number(r.distance) : null;
      const score = dist != null ? Math.max(0, Math.min(100, Math.round((1 - dist) * 100))) : null;
      const body = String(r.content || "").slice(0, 800);
      return `【${i + 1}】来源：${r.source || "未知"}${score != null ? `（相关度 ${score}%）` : ""}\n${body}`;
    });
    return {
      ok: true,
      text: `找到 ${results.length} 条相关内容：\n\n` + lines.join("\n\n---\n\n"),
      data: { results: results.map(r => ({ source: r.source, content: r.content, distance: r.distance })) }
    };
  } catch (e) {
    return { ok: false, text: "检索出错：" + e.message };
  }
}

// 列出当前可用的 Skill（让模型知道自己有哪些角色可用）
function toolListSkills(args) {
  const box = document.getElementById("skillSelect");
  if (!box) return { ok: false, text: "无法读取 Skill 列表" };
  const items = Array.from(box.options)
    .filter(o => o.value && o.value !== "__combo__")
    .map(o => {
      const meta = skillMetaCache[o.value];
      return { id: o.value, name: o.text, scope: meta ? meta.scope : "self" };
    });
  if (!items.length) return { ok: true, text: "当前没有可用的 Skill。", data: { skills: [] } };
  const lines = items.map(s => `- ${s.name}（id: ${s.id}，RAG 范围: ${s.scope === "all" ? "全库" : "本Skill"}）`);
  return {
    ok: true,
    text: `共 ${items.length} 个可用 Skill：\n` + lines.join("\n") +
          (currentSkillIds.length ? `\n\n当前已加载：${currentSkillName || currentSkillIds.join(", ")}` : "\n\n当前未加载任何 Skill。"),
    data: { skills: items }
  };
}

// 查看当前对话的基本状态（让模型了解上下文背景）
function toolGetSessionInfo(args) {
  const s = getCurrentSession();
  if (!s) return { ok: true, text: "当前没有打开的对话。" };
  const userMsgs = s.messages.filter(m => m.role === "user").length;
  const aiMsgs = s.messages.filter(m => m.role === "assistant" && !m.isSummary).length;
  const out = {
    title: s.title || "未命名",
    消息总数: s.messages.length,
    用户消息数: userMsgs,
    AI回复数: aiMsgs,
    当前模型: cfg.model || "未选择",
    知识库检索: cfg.ragEnabled ? "已开启" : "已关闭",
    长期记忆注入: cfg.memoryEnabled ? "已开启" : "已关闭",
    加载的Skill: currentSkillIds.length ? (currentSkillName || currentSkillIds.join(", ")) : "无"
  };
  const text = "当前对话状态：\n" + Object.entries(out).map(([k, v]) => `- ${k}：${v}`).join("\n");
  return { ok: true, text, data: out };
}

// ============ 工具注册表 ============
// schema 走标准 JSON Schema，Ollama 与 OpenAI 兼容平台通用。
// readOnly=true 表示无副作用，可以在 toolAutoApprove 开启时自动执行。
const TOOLS_REGISTRY = [
  {
    name: "rag_search",
    readOnly: true,
    label: "检索知识库",
    description: "在用户本地知识库中检索与查询相关的文档片段。当用户的问题可能需要参考资料、设定文档或历史笔记时使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索用的查询词，尽量精简为关键词或一句话" },
        top_k: { type: "integer", description: "返回片段数量，1~10，默认 4" }
      },
      required: ["query"]
    },
    run: toolRagSearch
  },
  {
    name: "get_current_time",
    readOnly: true,
    label: "读取当前时间",
    description: "获取本机当前的日期与时间。当用户问到‘今天几号’‘现在几点’或需要基于当前时间推算时使用。你无法自行知道当前时间。",
    parameters: { type: "object", properties: {}, required: [] },
    run: toolGetCurrentTime
  },
  {
    name: "calculator",
    readOnly: true,
    label: "计算器",
    description: "精确计算一个数学表达式，支持 + - * / % ( ) 与 ^（乘方）。当你需要做算术、且要求结果准确时使用，不要自己心算。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "数学表达式，例如 (12+34)*5/2 或 2^10" }
      },
      required: ["expression"]
    },
    run: toolCalculator
  },
  {
    name: "list_skills",
    readOnly: true,
    label: "列出可用 Skill",
    description: "列出用户当前配置的所有 Skill（角色/能力包）以及正在加载的 Skill。当用户询问有哪些角色可用时使用。",
    parameters: { type: "object", properties: {}, required: [] },
    run: toolListSkills
  },
  {
    name: "get_session_info",
    readOnly: true,
    label: "读取会话信息",
    description: "读取当前对话的基本状态，包括标题、消息数量、使用的模型、知识库与记忆开关、已加载的 Skill。",
    parameters: { type: "object", properties: {}, required: [] },
    run: toolGetSessionInfo
  }
];

// ============ 注册表查询 ============

function getToolByName(name) {
  return TOOLS_REGISTRY.find(t => t.name === name) || null;
}

// 转成发给模型的定义数组（去掉 run / readOnly / label 这些本地字段）
function getToolSchemas() {
  return TOOLS_REGISTRY.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

function getToolDisplayName(name) {
  const t = getToolByName(name);
  return t ? t.label : (name || "未知工具");
}

// ============ 参数解析 ============

// 模型给的 arguments 是一个 JSON 字符串，但经常出现以下毛病，必须容错：
//   1. 流式被打断导致 JSON 不完整
//   2. 外面裹了 ```json ... ``` 代码围栏
//   3. 空字符串或纯空白
function parseToolArguments(raw) {
  if (raw == null) return {};
  const text = String(raw).trim();
  if (!text) return {};
  // 剥掉 markdown 代码围栏
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const v = JSON.parse(stripped);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : { value: v };
  } catch (e) {
    // 兜底：尝试截取第一个 { 到最后一个 }
    const a = stripped.indexOf("{");
    const b = stripped.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        const v = JSON.parse(stripped.slice(a, b + 1));
        if (v && typeof v === "object") return v;
      } catch (e2) {}
    }
    return { __parse_error: true, __raw: stripped };
  }
}

// ============ 执行 ============

// 执行一个工具调用，永远返回 { ok, text, data?, ms }，绝不抛异常。
async function executeToolCall(call) {
  const started = Date.now();
  const name = call && call.function && call.function.name;
  const tool = getToolByName(name);
  if (!tool) {
    return { ok: false, text: `错误：不存在名为 "${name}" 的工具。可用工具：${TOOLS_REGISTRY.map(t => t.name).join(", ")}`, ms: 0 };
  }
  const args = parseToolArguments(call.function.arguments);
  let result;
  try {
    if (args.__parse_error) {
      result = { ok: false, text: `错误：工具参数不是合法 JSON，无法解析。原始内容：${String(args.__raw).slice(0, 300)}` };
    } else {
      result = await tool.run(args);
    }
  } catch (e) {
    result = { ok: false, text: `工具执行出错：${e.message}` };
  }
  if (!result || typeof result !== "object") result = { ok: false, text: "工具没有返回结果" };
  result.ms = Date.now() - started;
  return result;
}

// 把工具结果转成回灌给模型的字符串（限制长度，避免撑爆上下文）
function toolResultToText(result) {
  const body = (result && result.text) ? String(result.text) : "(工具没有返回任何内容)";
  const MAX = 4000;
  return body.length > MAX ? body.slice(0, MAX) + "\n…(结果过长已截断)" : body;
}

// ============ 状态文案 ============

function setToolRoundStatus(current, max) {
  toolRoundCurrent = current;
  toolRoundMax = max;
  if (typeof setStatus === "function") {
    setStatus(`🔧 工具调用中…（第 ${current}/${max} 轮）`);
  }
}
