// ============ 全局配置 ============
// 默认配置 + 持久化 + 主题/外观应用

const DEFAULT_CFG = {
  url: "http://127.0.0.1:11434",
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
  compareConcurrent: false
};

let cfg = { ...DEFAULT_CFG };

const LS = {
  cfg: "chat_cfg",
  sessions: "chat_sessions",
  presets: "chat_presets",
  drafts: "chat_drafts"
};

function getRagUrl() {
  return (cfg.ragUrl || DEFAULT_CFG.ragUrl).replace(/\/$/, "");
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