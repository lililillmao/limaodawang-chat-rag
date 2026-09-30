// ============ 全局配置 ============

const DEFAULT_CFG = {
  providers: [
    {
      id: "ollama",
      type: "ollama",
      name: "本地 Ollama",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: ""
    }
  ],
  ragUrl: "http://127.0.0.1:8000",
  dir: "",
  system: "",
  temperature: 0.7,
  top_p: 0.9,
  contextRounds: 20,
  theme: "dark",
  model: "",
  model2: "",
  num_ctx: 8192,
  num_predict: 1024,
  compareMode: false,
  fontSize: 15,
  accent: "",
  quickPrompts: ["翻译", "总结", "改代码"],
  emoMap: {},
  ragEnabled: false,
  compareConcurrent: false,
  // ★ 长期记忆配置
  memoryEnabled: true, // 默认开启记忆
  memoryRounds: 3,    // 检索时注入最相关的前 N 条记忆
  memoryExtract: true, // 自动从对话提取记忆
  // ★ 1.23 视觉输入
  visionEnabled: true,     // 允许拖拽/上传图片
  imageMaxEdge: 1568,      // 图片压缩后的最长边（像素）
  // ★ 1.23 工具调用
  toolsEnabled: false,     // 默认关闭，避免不支持 tool calling 的模型报错
  maxToolRounds: 5,        // 最大工具调用轮次，防止死循环
  toolAutoApprove: true,   // 只读工具自动执行，无需逐次确认
  // ★ 修复（16）：补上预设持久化字段的默认值。
  //   之前 1.23 一直靠 `cfg.activePresetId || ""` 的兜底在运行，
  //   显式声明可以让"恢复备份"和"重置配置"的默认值语义更清晰。
  activePresetId: ""
};

let cfg = { ...DEFAULT_CFG };

const LS = {
  cfg: "chat_cfg",
  sessions: "chat_sessions",
  presets: "chat_presets",
  drafts: "chat_drafts",
  usage: "chat_usage",         // ★ 1.23 成本统计聚合
  usageLog: "chat_usage_log"   // ★ 1.23 成本统计明细日志
};

function getRagUrl() {
  return (cfg.ragUrl || DEFAULT_CFG.ragUrl).replace(/\/$/, "");
}

function getCurrentProvider() {
  const providerId = cfg.modelProviderId || currentProviderId || "ollama";
  return cfg.providers.find(p => p.id === providerId) || cfg.providers[0];
}

function loadLocal() {
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS.cfg) || "{}")); } catch (e) {}
  try { sessions = JSON.parse(localStorage.getItem(LS.sessions) || "[]"); } catch (e) { sessions = []; }
  try { presets = JSON.parse(localStorage.getItem(LS.presets) || "[]"); } catch (e) { presets = []; }
  try { drafts = JSON.parse(localStorage.getItem(LS.drafts) || "{}"); } catch (e) { drafts = {}; }
  if (!Array.isArray(sessions)) sessions = [];
  if (!Array.isArray(presets)) presets = [];
  if (!drafts || typeof drafts !== "object") drafts = {};
  if (!cfg.quickPrompts || !Array.isArray(cfg.quickPrompts)) cfg.quickPrompts = ["翻译", "总结", "改代码"];
  if (!cfg.emoMap || typeof cfg.emoMap !== "object" || Array.isArray(cfg.emoMap)) cfg.emoMap = {};
  if (!cfg.ragUrl) cfg.ragUrl = DEFAULT_CFG.ragUrl;
  if (!cfg.num_predict) cfg.num_predict = 1024;
  // ★ 修复（16）：旧版配置没有 activePresetId，读取时补默认值
  if (cfg.activePresetId === undefined) cfg.activePresetId = "";
  
  // 兼容旧版配置：如果没有 providers，则根据旧版 url 生成一个
  if (!cfg.providers || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    cfg.providers = [
      {
        id: "ollama",
        type: "ollama",
        name: "本地 Ollama",
        baseUrl: cfg.url || "http://127.0.0.1:11434",
        apiKey: ""
      }
    ];
  }
  delete cfg.url; 
}

function saveLocal() {
  localStorage.setItem(LS.cfg, JSON.stringify(cfg));
  localStorage.setItem(LS.sessions, JSON.stringify(sessions));
  localStorage.setItem(LS.presets, JSON.stringify(presets));
  localStorage.setItem(LS.drafts, JSON.stringify(drafts));
}

function applyFontSize() {
  document.documentElement.style.setProperty('--font-size', (cfg.fontSize || 15) + "px");
}

function applyAccentColor() {
  const c = cfg.accent || "";
  if (!c) {
    document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.removeProperty("--accent-hover");
    return;
  }
  const hover = cfg.theme === "dark" ? lightenHex(c, .15) : darkenHex(c, .1);
  document.documentElement.style.setProperty("--accent", c);
  document.documentElement.style.setProperty("--accent-hover", hover);
}

function applyTheme() {
  document.documentElement.dataset.theme = cfg.theme;
  document.getElementById("themeToggle").textContent = cfg.theme === "dark" ? "☀️" : "🌙";
  document.getElementById("hljs-dark").disabled = cfg.theme !== "dark";
  document.getElementById("hljs-light").disabled = cfg.theme === "dark";
  applyAccentColor();
}

// ============ 参数三级继承 ============
const PARAM_KEYS = ["temperature", "top_p", "num_ctx", "num_predict"];

function hasValue(v) {
  return v !== undefined && v !== null && v !== "";
}

function resolveParam(key) {
  const s = getCurrentSession();
  if (s && s.params && hasValue(s.params[key])) {
    return { value: s.params[key], source: "session" };
  }
  if (currentPresetId) {
    const p = presets.find(x => x.id === currentPresetId);
    if (p && p.params && hasValue(p.params[key])) {
      return { value: p.params[key], source: "preset" };
    }
  }
  return { value: cfg[key], source: "global" };
}

function getEffectiveParams() {
  const out = {};
  for (const k of PARAM_KEYS) out[k] = resolveParam(k).value;
  return out;
}