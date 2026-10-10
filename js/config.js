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
  memoryEnabled: true,
  memoryRounds: 3,
  memoryExtract: true,
  // ★ 1.23 视觉输入
  visionEnabled: true,
  // ★ 修复 #8：默认最长边从 1568 降到 1024。
  //   1568px 的 JPEG 通常 300~500KB，4 张就超过 1MB，几轮就会打爆 localStorage 5MB 配额。
  //   1024px 足够让大多数视觉模型识别内容，体积小一半以上。
  //   用户如果需要更高清，可以在「设置 → 视觉输入」里手动调回。
  imageMaxEdge: 1024,
  // ★ 1.23 工具调用
  toolsEnabled: false,
  maxToolRounds: 5,
  toolAutoApprove: true,
  // ★ 修复（16）：补上预设持久化字段的默认值。
  activePresetId: ""
};

let cfg = { ...DEFAULT_CFG };

// 键名清单的唯一事实现在在持久化模块里（js/persistence.js 的 PERSIST_KEY）。
// LS 是迁移期的旧别名，等调用点改完再退役。
const LS = PERSIST_KEY;

function getRagUrl() {
  return (cfg.ragUrl || DEFAULT_CFG.ragUrl).replace(/\/$/, "");
}

function getCurrentProvider() {
  const providerId = cfg.modelProviderId || currentProviderId || "ollama";
  return cfg.providers.find(p => p.id === providerId) || cfg.providers[0];
}

// 薄壳：读取与归一化都搬进持久化模块了（单一主人）。
// 保留这个名字是因为 main.js / 测试 / export.js 都还在调它。
function loadLocal() {
  loadLocalState();
}

// 薄壳：历史上写 cfg+sessions+presets+drafts 四个键。
// 现在委托给持久化模块 —— 除了本地存储，它还会把会话数据集写进真正的家。
// 注意：本地存储写入保持同步并同步抛出，importer 的配额回滚依赖这个语义。
function saveLocal() {
  persistAllShim();
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