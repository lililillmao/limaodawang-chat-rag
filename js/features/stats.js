// ============ 成本统计（token 计量 + 费用估算 + CSV 导出） ============
// 独立模块：不依赖任何构建工具，直接被 <script src> 顺序加载。
// 本文件只暴露 window.LimaoStats，不改动其它任何文件。

// ---------- 存储 key（独立于 cfg / sessions，避免拖慢 saveLocal） ----------
const USAGE_LS_KEY = "chat_usage";         // ★ 聚合数据（按天 + provider|model）
const USAGE_LOG_LS_KEY = "chat_usage_log"; // ★ 明细日志
const USAGE_LOG_MAX = 5000;                // ★ 日志硬上限，超出从头部滚动删除
const USAGE_SAVE_GAP = 800;                // ★ 落盘节流间隔（毫秒）

// ---------- 价格表：单位「美元 / 每百万 token」 ----------
// 价格为参考值（公开报价的近似值），可自行修改。
// 匹配规则：模型名 toLowerCase() 后「包含」某个 key 即命中。
const USAGE_PRICE_TABLE = {
  // 顺序很关键：先长后短，避免 "glm-4-plus" 被 "glm-4" 抢先命中
  "glm-4-plus": { in: 0.7, out: 0.7 },
  "glm-4": { in: 0.14, out: 0.14 },

  "deepseek-reasoner": { in: 0.55, out: 2.19 },
  "deepseek-chat": { in: 0.14, out: 0.28 },

  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1": { in: 2, out: 8 },

  "claude-3-5-sonnet": { in: 3, out: 15 },
  "claude-3-7-sonnet": { in: 3, out: 15 },
  "claude-sonnet-4": { in: 3, out: 15 },

  "moonshot-v1-8k": { in: 1.68, out: 1.68 },
  "kimi-k2": { in: 0.6, out: 2.5 },

  "qwen-max": { in: 1.6, out: 6.4 },
  "qwen-plus": { in: 0.4, out: 1.2 },

  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 }
};

// 本地模型名字前缀白名单（没有命中价格表时按「本地」处理，成本恒为 0）
const USAGE_LOCAL_RE = /^(qwen|llama|mistral|gemma|phi|deepseek-r1|nomic|llava|minicpm|yi)/;

// ---------- 内存缓存（懒加载） ----------
const _usageMem = { v: 1, days: {} }; // ★ 聚合对象（O(1) 累加用）
const _usageLogMem = [];              // ★ 明细日志
let _usageLoaded = false;             // ★ 是否已从 localStorage 读过
let _usageDirty = false;              // ★ 是否有未落盘的改动
let _usageTimer = null;               // ★ 节流定时器
let _usageLastSave = 0;               // ★ 上次落盘时间戳

// 面板 select 的持久化偏好（各自独立小 key，不碰 cfg）
let _usageRangePref = "30";
let _usageGroupPref = "provider";
let _usageChartMode = "calls"; // ★ 趋势图视图：calls | tokens

// ============ 小工具（统一 usage 前缀防冲突） ============

function usageFmtInt(n) {
  try { return (Number(n) || 0).toLocaleString("zh-CN"); } catch (e) { return String(Number(n) || 0); }
}

function usageFmtCost(v) {
  const n = Number(v) || 0;
  if (!n) return "免费";
  if (n < 0.0001) return "$" + n.toExponential(2);
  return "$" + n.toFixed(4);
}

function usageLocalDateKey(ts) {
  try {
    const d = new Date(ts || Date.now());
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  } catch (e) {
    return "1970-01-01";
  }
}

function usageSafeHtml(s) {
  try {
    if (typeof escapeHtml === "function") return escapeHtml(s);
  } catch (e) { }
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function usageSafeInt(v, def) {
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return (typeof def === "number" ? def : 0);
  return n;
}

function usageSafeCost(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

// ★ 安全读 cfg.providers（cfg 已由 config.js 定义，这里仍然防一手）
function usageGetProviders() {
  try {
    if (typeof cfg !== "undefined" && cfg && Array.isArray(cfg.providers)) return cfg.providers;
  } catch (e) { }
  return [];
}

function _usageFindPriceKey(modelLower) {
  const m = String(modelLower || "").toLowerCase();
  if (!m) return "";
  return Object.keys(USAGE_PRICE_TABLE).find(k => m.includes(k)) || "";
}

// ★ 严格判本地：Ollama 平台，或「名字像本地模型 + 没命中价格表」
// 注意：命中价格表就按云端收费，避免 qwen-max 这种云端模型被误判成免费
function isLocalModel(model, provider) {
  try {
    if (provider && String(provider.type || "").toLowerCase() === "ollama") return true;
    const m = String(model || "").toLowerCase().trim();
    if (!m) return false;
    if (_usageFindPriceKey(m)) return false;
    return USAGE_LOCAL_RE.test(m);
  } catch (e) {
    return false;
  }
}

// ============ B. 核心函数 ============

// ★ 计算费用（美元）。未知模型 / 本地模型返回 0。
function estimateCost(model, p, c) {
  try {
    const m = String(model || "").toLowerCase().trim();
    if (!m) return 0;
    const key = _usageFindPriceKey(m);
    if (!key) return 0;
    const price = USAGE_PRICE_TABLE[key] || { in: 0, out: 0 };
    const inTok = usageSafeInt(p, 0);
    const outTok = usageSafeInt(c, 0);
    const cost = (inTok / 1e6) * (Number(price.in) || 0) + (outTok / 1e6) * (Number(price.out) || 0);
    return isFinite(cost) && cost > 0 ? cost : 0;
  } catch (e) {
    console.warn("⚠️ 费用估算失败", e);
    return 0;
  }
}

// ★ 读 localStorage 到内存缓存，返回聚合对象
function loadUsage() {
  try {
    if (_usageLoaded) return _usageMem;
    let agg = null;
    try { agg = JSON.parse(localStorage.getItem(USAGE_LS_KEY) || "null"); } catch (e) { agg = null; }
    if (agg && typeof agg === "object" && agg.days && typeof agg.days === "object") {
      _usageMem.v = agg.v || 1;
      _usageMem.days = agg.days;
    } else {
      _usageMem.v = 1;
      _usageMem.days = {};
    }
    let log = null;
    try { log = JSON.parse(localStorage.getItem(USAGE_LOG_LS_KEY) || "null"); } catch (e) { log = null; }
    _usageLogMem.length = 0;
    if (Array.isArray(log)) {
      const cut = log.length > USAGE_LOG_MAX ? log.slice(-USAGE_LOG_MAX) : log;
      for (const it of cut) _usageLogMem.push(it);
    }
    _usageLoaded = true;
    return _usageMem;
  } catch (e) {
    console.warn("⚠️ 读取用量统计失败", e);
    _usageLoaded = true;
    return _usageMem;
  }
}

// ★ 落盘。force=true 立即写；否则按 800ms 节流。
function saveUsage(force) {
  try {
    loadUsage();
    if (force) {
      if (_usageTimer) { clearTimeout(_usageTimer); _usageTimer = null; }
      _usageWriteNow();
      return;
    }
    if (!_usageDirty) return;
    const now = Date.now();
    const elapsed = now - _usageLastSave;
    if (elapsed >= USAGE_SAVE_GAP) {
      if (_usageTimer) { clearTimeout(_usageTimer); _usageTimer = null; }
      _usageWriteNow();
      return;
    }
    if (_usageTimer) return;
    _usageTimer = setTimeout(() => {
      _usageTimer = null;
      _usageWriteNow();
    }, USAGE_SAVE_GAP - elapsed);
  } catch (e) {
    console.warn("⚠️ 用量统计落盘调度失败", e);
  }
}

function _usageWriteNow() {
  try {
    localStorage.setItem(USAGE_LS_KEY, JSON.stringify(_usageMem));
    localStorage.setItem(USAGE_LOG_LS_KEY, JSON.stringify(_usageLogMem));
    _usageDirty = false;
    _usageLastSave = Date.now();
  } catch (e) {
    console.warn("⚠️ 用量统计落盘失败（可能是 localStorage 满了）", e);
  }
}

// ★ 强制立刻落盘（集成方可在 beforeunload 里调用，避免丢最后 <800ms 的数据）
function flushUsage() {
  try { saveUsage(true); } catch (e) { console.warn("⚠️ 用量统计强制落盘失败", e); }
}

// ★ 记账入口。绝不抛异常；返回 { ok, cost, isLocal, p, c, key } 便于集成方提示
function recordUsage(entry) {
  const out = { ok: false, cost: 0, isLocal: false, p: 0, c: 0, key: "" };
  try {
    if (!entry || typeof entry !== "object") return out;

    // 1) 解析平台
    const providers = usageGetProviders();
    let pid = (entry.providerId != null && entry.providerId !== "") ? String(entry.providerId) : "";
    if (!pid) {
      try {
        if (typeof cfg !== "undefined" && cfg && cfg.modelProviderId) pid = String(cfg.modelProviderId);
      } catch (e) { }
    }
    if (!pid) pid = "unknown";
    const provider = providers.find(x => x && String(x.id) === pid) || null;

    // 2) 解析模型名
    let model = String(entry.model == null ? "" : entry.model).trim();
    if (!model) {
      try {
        if (typeof cfg !== "undefined" && cfg && cfg.model) model = String(cfg.model);
      } catch (e) { }
    }
    if (!model) model = "(未知模型)";

    // 3) 平台名
    let pname = entry.providerName ? String(entry.providerName) : "";
    if (!pname && provider) pname = String(provider.name || provider.id || pid);
    if (!pname) pname = pid;

    // 4) token 数
    const p = usageSafeInt(entry.promptTokens, 0);
    const c = usageSafeInt(entry.completionTokens, 0);

    // 5) 费用：本地模型恒为 0
    const local = isLocalModel(model, provider);
    const cost = local ? 0 : estimateCost(model, p, c);

    // 6) 累加到 days[日期][providerId|model]（O(1)）
    const day = usageLocalDateKey(Date.now());
    const key = pid + "|" + model;
    const agg = loadUsage();
    if (!agg.days[day] || typeof agg.days[day] !== "object") agg.days[day] = {};
    const bucket = agg.days[day][key] || { p: 0, c: 0, n: 0, cost: 0 };
    bucket.p = usageSafeInt(bucket.p, 0) + p;
    bucket.c = usageSafeInt(bucket.c, 0) + c;
    bucket.n = usageSafeInt(bucket.n, 0) + 1;
    bucket.cost = usageSafeCost(bucket.cost) + cost;
    agg.days[day][key] = bucket;

    // 7) 明细日志（硬上限 5000，超出从头部滚动删除）
    const kinds = { chat: 1, compare: 1, memory: 1, tool: 1 };
    const kind = kinds[entry.kind] ? entry.kind : "chat";
    _usageLogMem.push({
      ts: Date.now(),
      providerId: pid,
      providerName: pname,
      model: model,
      p: p,
      c: c,
      cost: cost,
      sessionId: entry.sessionId ? String(entry.sessionId) : "",
      kind: kind
    });
    while (_usageLogMem.length > USAGE_LOG_MAX) _usageLogMem.shift();

    // 8) 节流落盘
    _usageDirty = true;
    saveUsage(false);

    out.ok = true;
    out.cost = cost;
    out.isLocal = local;
    out.p = p;
    out.c = c;
    out.key = key;
    return out;
  } catch (e) {
    console.warn("⚠️ 记录用量失败", e);
    return out;
  }
}

// ★ 汇总。opts = { days: 30, groupBy: "provider" | "model" | "day" }
// 返回 { rows:[{ key, label, p, c, total, cost, calls, isLocal }], totals:{ p, c, cost, calls } }
function getUsageSummary(opts) {
  const o = opts || {};
  const groupBy = (o.groupBy === "model" || o.groupBy === "day") ? o.groupBy : "provider";
  const days = (o.days === 0 || o.days === "all" || o.days == null) ? 0 : (parseInt(o.days, 10) || 0);
  const result = { rows: [], totals: { p: 0, c: 0, cost: 0, calls: 0 }, groupBy: groupBy, days: days };

  try {
    const agg = loadUsage();

    // 时间范围：从「今天往前 N-1 天」的 0 点开始
    let fromTs = 0;
    if (days > 0) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (days - 1));
      fromTs = d.getTime();
    }

    const providers = usageGetProviders();
    const byKey = {};

    for (const dayKey in agg.days) {
      const dayMap = agg.days[dayKey];
      if (!dayMap || typeof dayMap !== "object") continue;
      const dayTs = new Date(dayKey + "T00:00:00").getTime();
      if (fromTs && !(dayTs >= fromTs)) continue;

      for (const fullKey in dayMap) {
        const b = dayMap[fullKey] || {};
        const bp = usageSafeInt(b.p, 0);
        const bc = usageSafeInt(b.c, 0);
        const bn = usageSafeInt(b.n, 0);
        const bcost = usageSafeCost(b.cost);
        const cut = fullKey.indexOf("|");
        const pid = cut >= 0 ? fullKey.slice(0, cut) : fullKey;
        const model = cut >= 0 ? fullKey.slice(cut + 1) : "";

        let rk, label, rPid = pid;
        if (groupBy === "day") {
          rk = dayKey;
          label = dayKey;
        } else if (groupBy === "model") {
          rk = model || "(未知模型)";
          label = model || "(未知模型)";
        } else {
          rk = pid || "(未知平台)";
          const pv = providers.find(x => x && String(x.id) === pid);
          label = pv ? String(pv.name || pv.id) : (pid || "(未知平台)");
        }

        if (!byKey[rk]) byKey[rk] = { key: rk, label: label, p: 0, c: 0, cost: 0, calls: 0, pid: rPid, model: model };
        const row = byKey[rk];
        row.p += bp;
        row.c += bc;
        row.cost += bcost;
        row.calls += bn;
      }
    }

    const rows = [];
    for (const k in byKey) {
      const r = byKey[k];
      let isLocal = r.cost <= 0;
      if (groupBy === "model") {
        isLocal = isLocalModel(r.key, providers.find(x => x && String(x.id) === r.pid));
      } else if (groupBy === "day") {
        isLocal = false;
      }
      rows.push({
        key: r.key,
        label: r.label,
        p: r.p,
        c: r.c,
        total: r.p + r.c,
        cost: r.cost,
        calls: r.calls,
        isLocal: isLocal
      });
    }

    // 排序：按天 → 日期倒序（新的在上）；其它 → 调用次数倒序
    if (groupBy === "day") rows.sort((a, b) => b.key < a.key ? -1 : (b.key > a.key ? 1 : 0));
    else rows.sort((a, b) => (b.calls - a.calls) || (b.total - a.total) || (a.label > b.label ? 1 : -1));

    for (const r of rows) {
      result.totals.p += r.p;
      result.totals.c += r.c;
      result.totals.cost += r.cost;
      result.totals.calls += r.calls;
    }
    result.rows = rows;
    return result;
  } catch (e) {
    console.warn("⚠️ 汇总用量失败", e);
    return result;
  }
}

// ============ D. 面板 UI ============

function usageReadPrefs() {
  try {
    const r = localStorage.getItem("chat_stats_range");
    if (r) _usageRangePref = r;
    const g = localStorage.getItem("chat_stats_group");
    if (g) _usageGroupPref = g;
  } catch (e) { }
}

function usageSavePrefs() {
  try {
    localStorage.setItem("chat_stats_range", _usageRangePref);
    localStorage.setItem("chat_stats_group", _usageGroupPref);
  } catch (e) { }
}

// ★ 纯 CSS/SVG 柱状趋势图（零图表库）：两种视图可切换
function usageBuildChart(daysVal) {
  const byDay = getUsageSummary({ days: daysVal, groupBy: "day" });
  const days = byDay.rows.slice().sort((a, b) => a.key < b.key ? -1 : 1); // 旧的在前
  if (!days.length) return "";

  const maxCalls = Math.max(1, ...days.map(d => d.calls));
  const maxTotal = Math.max(1, ...days.map(d => d.total));
  const isCalls = _usageChartMode === "calls";
  const W = 100, H = 40, n = days.length, slot = W / n;

  const bars = days.map((d, i) => {
    const v = isCalls ? d.calls : d.total;
    const mx = isCalls ? maxCalls : maxTotal;
    const bh = Math.max(0.5, (v / mx) * (H - 3));
    const y = H - bh;
    const bw = Math.max(0.5, slot * 0.62);
    const tip = d.key + " · 调用 " + d.calls + " 次 · token " + d.total + " · " + usageFmtCost(d.cost);
    return `<rect class="stats-bar" x="${(i * slot).toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6"><title>${usageSafeHtml(tip)}</title></rect>`;
  }).join("");

  return `<div class="stats-chart">
    <div class="stats-chart-head">
      <span class="stats-chart-title">📈 趋势（按天 · ${isCalls ? "调用次数" : "token 总量"}）</span>
      <span class="stats-chart-hint">共 ${n} 天有数据</span>
      <button type="button" class="stats-mini-btn" id="statsChartToggle">切换视图</button>
    </div>
    <svg class="stats-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
    <div class="stats-chart-axis"><span>${usageSafeHtml(days[0].key)}</span><span>${usageSafeHtml(days[n - 1].key)}</span></div>
  </div>`;
}

// ★ 渲染统计面板内容到 #statsBody
function renderStatsPanel() {
  const box = document.getElementById("statsBody");
  if (!box) {
    console.warn("⚠️ 找不到 #statsBody，无法渲染统计面板");
    return;
  }
  try {
    usageReadPrefs();
    const daysVal = _usageRangePref === "all" ? 0 : (parseInt(_usageRangePref, 10) || 30);
    const groupBy = (_usageGroupPref === "model" || _usageGroupPref === "day") ? _usageGroupPref : "provider";
    const sum = getUsageSummary({ days: daysVal, groupBy: groupBy });

    // --- 1) 顶部汇总卡片 ---
    const cards = `<div class="stats-cards">
      <div class="stats-card"><div class="stats-card-label">总调用次数</div><div class="stats-card-value">${usageFmtInt(sum.totals.calls)}</div><div class="stats-card-sub">次</div></div>
      <div class="stats-card"><div class="stats-card-label">prompt tokens</div><div class="stats-card-value">${usageFmtInt(sum.totals.p)}</div><div class="stats-card-sub">输入</div></div>
      <div class="stats-card"><div class="stats-card-label">completion tokens</div><div class="stats-card-value">${usageFmtInt(sum.totals.c)}</div><div class="stats-card-sub">输出</div></div>
      <div class="stats-card"><div class="stats-card-label">总费用</div><div class="stats-card-value stats-card-cost">${usageSafeHtml(usageFmtCost(sum.totals.cost))}</div><div class="stats-card-sub">美元（估算）</div></div>
    </div>`;

    // --- 2) 控制行 ---
    const selHtml = (id, val, opts) => `<select id="${id}" class="stats-select">` +
      opts.map(o => `<option value="${usageSafeHtml(o[0])}"${String(o[0]) === String(val) ? " selected" : ""}>${usageSafeHtml(o[1])}</option>`).join("") +
      `</select>`;

    const controls = `<div class="stats-controls">
      <span class="stats-ctrl-label">时间范围</span>
      ${selHtml("statsRange", _usageRangePref, [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"], ["all", "全部"]])}
      <span class="stats-ctrl-label">分组</span>
      ${selHtml("statsGroupBy", groupBy, [["provider", "按平台"], ["model", "按模型"], ["day", "按天"]])}
      <span class="stats-spacer"></span>
      <button type="button" class="stats-mini-btn" id="statsExportBtn">↧ 导出 CSV</button>
      <button type="button" class="stats-mini-btn danger" id="statsClearBtn">🗑 清空统计</button>
    </div>`;

    // --- 3) 趋势图 ---
    const chart = sum.rows.length ? usageBuildChart(daysVal) : "";

    // --- 4) 表格 ---
    const headName = groupBy === "day" ? "日期" : (groupBy === "model" ? "模型" : "平台");
    let table;
    if (!sum.rows.length) {
      table = `<div class="stats-empty">还没有统计数据，去聊两句吧 🐾</div>`;
    } else {
      const trs = sum.rows.map(r => {
        const tag = r.isLocal ? `<span class="stats-tag local">本地</span>` : ``;
        const costCell = r.cost > 0
          ? `<span class="stats-cost">${usageSafeHtml(usageFmtCost(r.cost))}</span>`
          : `<span class="stats-cost free">${r.isLocal ? "本地免费" : "免费"}</span>`;
        return `<tr>
          <td class="stats-td-name">${usageSafeHtml(r.label)}${tag}</td>
          <td class="stats-td-num">${usageFmtInt(r.calls)}</td>
          <td class="stats-td-num">${usageFmtInt(r.p)}</td>
          <td class="stats-td-num">${usageFmtInt(r.c)}</td>
          <td class="stats-td-num">${costCell}</td>
        </tr>`;
      }).join("");
      table = `<div class="stats-table-wrap">
        <table class="stats-table">
          <thead><tr>
            <th class="stats-th-name">${usageSafeHtml(headName)}</th><th>调用次数</th><th>prompt tokens</th><th>completion tokens</th><th>费用</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>`;
    }

    const note = `<div class="stats-note">费用为估算值：价格表在 stats.js 顶部 USAGE_PRICE_TABLE（美元/百万 token），可自行修改；本地模型（Ollama）不产生费用。</div>`;

    box.innerHTML = cards + controls + chart + table + note;

    // --- 5) 事件绑定（项目风格：onXxx = ，不用事件委托） ---
    const rangeEl = document.getElementById("statsRange");
    if (rangeEl) rangeEl.onchange = () => { _usageRangePref = rangeEl.value || "30"; usageSavePrefs(); renderStatsPanel(); };
    const groupEl = document.getElementById("statsGroupBy");
    if (groupEl) groupEl.onchange = () => { _usageGroupPref = groupEl.value || "provider"; usageSavePrefs(); renderStatsPanel(); };
    const toggleEl = document.getElementById("statsChartToggle");
    if (toggleEl) toggleEl.onclick = () => { _usageChartMode = _usageChartMode === "calls" ? "tokens" : "calls"; renderStatsPanel(); };
    const exportEl = document.getElementById("statsExportBtn");
    if (exportEl) exportEl.onclick = () => exportUsageCsv();
    const clearEl = document.getElementById("statsClearBtn");
    if (clearEl) clearEl.onclick = () => clearUsage();
  } catch (e) {
    console.warn("⚠️ 渲染统计面板失败", e);
    box.innerHTML = `<div class="stats-empty">统计数据读取失败，请检查浏览器存储权限</div>`;
  }
}

// ★ 打开统计弹窗
function openStats() {
  const mask = document.getElementById("statsMask");
  if (!mask) {
    console.warn("⚠️ 找不到 #statsMask，无法打开统计面板");
    return;
  }
  renderStatsPanel();
  mask.classList.add("show");
}

// ★ 关闭统计弹窗
function closeStats() {
  const mask = document.getElementById("statsMask");
  if (!mask) return;
  mask.classList.remove("show");
}

// ★ 导出当前汇总为 CSV（带 UTF-8 BOM，Excel 不乱码）
function exportUsageCsv() {
  try {
    usageReadPrefs();
    const daysVal = _usageRangePref === "all" ? 0 : (parseInt(_usageRangePref, 10) || 30);
    const groupBy = (_usageGroupPref === "model" || _usageGroupPref === "day") ? _usageGroupPref : "provider";
    const sum = getUsageSummary({ days: daysVal, groupBy: groupBy });

    const headName = groupBy === "day" ? "日期" : (groupBy === "model" ? "模型" : "平台");
    const esc = v => {
      const s = String(v == null ? "" : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [];
    lines.push([headName, "调用次数", "prompt_tokens", "completion_tokens", "total_tokens", "费用(USD)", "是否本地"].map(esc).join(","));
    for (const r of sum.rows) {
      lines.push([r.label, r.calls, r.p, r.c, r.total, r.cost.toFixed(6), r.isLocal ? "本地" : "云端"].map(esc).join(","));
    }
    lines.push(["总计", sum.totals.calls, sum.totals.p, sum.totals.c, sum.totals.p + sum.totals.c, sum.totals.cost.toFixed(6), ""].map(esc).join(","));
    lines.push("");
    lines.push(["导出时间", new Date().toLocaleString(), "范围", daysVal > 0 ? ("近 " + daysVal + " 天") : "全部", "价格仅供参考", "", ""].map(esc).join(","));

    const body = new TextEncoder().encode(lines.join("\r\n"));
    const buf = new Uint8Array(body.length + 3);
    buf[0] = 0xEF; buf[1] = 0xBB; buf[2] = 0xBF; // ★ 手写 BOM，保证 Excel 识别 UTF-8
    buf.set(body, 3);

    const blob = new Blob([buf], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
      "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
    a.download = "token用量统计_" + stamp + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("已导出用量 CSV");
  } catch (e) {
    console.warn("⚠️ 导出 CSV 失败", e);
    setStatus("导出 CSV 失败", true);
  }
}

// ★ 清空统计（二次 confirm，同时清 days 和 log）
function clearUsage() {
  try {
    if (!confirm("确定清空全部用量统计吗？聚合数据和明细日志都会被删除，无法恢复。")) return;
    if (!confirm("再次确认：真的要清空吗？（建议先导出 CSV 备份）")) return;
    _usageMem.v = 1;
    _usageMem.days = {};
    _usageLogMem.length = 0;
    _usageLoaded = true;
    _usageDirty = true;
    saveUsage(true);
    renderStatsPanel();
    setStatus("已清空用量统计");
  } catch (e) {
    console.warn("⚠️ 清空统计失败", e);
    setStatus("清空统计失败", true);
  }
}

// ============ 页面卸载兜底（避免丢掉最后 <800ms 的记账） ============
// ★ 只加自动兜底；集成方若已有 beforeunload，也可直接调用 flushUsage()
try {
  window.addEventListener("pagehide", () => { flushUsage(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushUsage();
  });
} catch (e) { }

// ★ 显式挂载：全项目唯一允许的 window 挂载风格，方便集成方确认模块已加载
// 额外提供 flushUsage（强制立即落盘），集成方可在 beforeunload 里调用
window.LimaoStats = { recordUsage, loadUsage, saveUsage, getUsageSummary, estimateCost, renderStatsPanel, openStats, closeStats, exportUsageCsv, clearUsage, flushUsage };
