// ============ 全局状态变量 ============
// 集中管理所有运行时状态，各模块共享

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
let navObserver = null;

// 模型列表缓存
let allModelsCache = [];

// 预设编辑临时 ID
let editingPresetId = null;

// 当前加载的 Skill
let currentSkillId = "";
let currentSkillName = "";

// 流式保存节流
let lastStreamSaveTs = 0;