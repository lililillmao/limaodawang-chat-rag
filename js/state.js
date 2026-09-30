// ============ 全局状态变量 ============

// 颜文字相关（Skill 加载时会被替换）
let dynamicEmo = {};
const EMO_RE = /\[emo:([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

// 会话数据
let sessions = [];
let currentSessionId = null;
let presets = [];
let currentPresetId = "";

// 文件夹同步
let folderHandle = null;

// 生成状态
let generating = false;
let abortCtrl = null;

// UI 状态
let userWantsAutoScroll = true;
let searchQuery = "";
let editingMsgIndex = -1;
let voiceRec = null;
let drafts = {};
let starFilter = false;
let quoteState = null;
let speakingBtn = null;
let navTicks = [];
// ★ 修复（7）：navTicks 是密集数组（只存可见消息的刻度），但高亮逻辑需要按
//   "消息下标"查找刻度。存在被跳过渲染的消息（隐藏消息 / 工具结果）时两者会错位，
//   表现为高亮错条或刻度永远不亮。故额外维护这张"消息下标 → 刻度元素"的映射。
let navTicksByMsgIdx = {};
let navObserver = null;

// 模型列表缓存
let allModelsCache = []; 

// 预设编辑临时 ID
let editingPresetId = null;

// 当前加载的 Skill（单个）
let currentSkillId = "";
let currentSkillName = "";
let currentSkillScope = "self";

// ★ 多 Skill 组合
let currentSkillIds = [];
let skillMetaCache = {};

// 流式保存节流
let lastStreamSaveTs = 0;

// 会话级参数弹窗编辑中的临时状态
let editingSessionParams = null;

// 模板变量：缓存最后一次非空选区
let cachedSelection = "";
let lastTplInputIdx = -1;

// ★ 多平台相关状态
let currentProviderId = "ollama";
let editingProviderId = null;

// ★ 临时 RAG 文件
let tempRagFiles = [];

// ★ 1.23：临时图片（多模态输入）
// 元素形状：{ name, mime, dataUrl, b64, size }
let tempImages = [];

// ★ 1.23：工具调用轮次显示
let toolRoundCurrent = 0;
let toolRoundMax = 0;

// ★ 长期记忆系统相关状态
let memories = []; // 记忆列表