# 狸猫AI工具盒 (Limaodawang AI Toolbox)

> 一个基于 Ollama 的本地大模型聊天客户端，支持 **动态 Skill 加载** 与 **RAG 知识库检索**。
> 前后端分离：模块化前端（原生 ES 风格多文件）+ 后端 Python (FastAPI + ChromaDB)。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)
![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-black.svg)

---

## ✨ 特性

### 1.20 版本核心更新

- 🧱 **前端模块化重构** —— 3000 行单文件 `index.html` 拆分为 `js/` 目录下 15 个模块 + `css/` 目录下 5 个样式表，`index.html` 只剩 190 行骨架
- 🧩 **Skill 加载记录与追溯** —— 每条 AI 回答记录生成时使用的 Skill（`skillId` / `skillName`），消息头显示徽章，导出 MD / TXT / JSON 时一并带上
- 🚀 **一键启动器** —— 新增 `启动狸猫AI.bat`，自动检测 Python 与 Ollama，同时拉起 RAG 后端与前端服务器并打开浏览器
- 🐛 **浏览器记忆状态修复** —— 修复刷新页面后下拉框显示 Skill 但实际未加载的问题

### 1.19 版本功能

- ⚡ **知识库一键重建** —— 告别命令行，在设置面板点击即可后台重建，带实时进度条
- 🚀 **增量更新** —— 智能识别修改过的文件，只处理变动部分，速度提升 10 倍
- 📚 **RAG 溯源 UI** —— 回答下方可展开查看引用的本地文档名称与片段
- ⚙️ **动态 Skill 目录** —— 无需重启服务，在设置面板修改路径即热重载
- ⚖️ **并发/串行对比开关** —— 根据电脑性能，自由选择双模型对比模式

### 1.18 版本首发功能

- 🧩 **动态 Skill 加载** —— 把任意 `SKILL.md` 放进 `skills/` 目录，前端下拉框选中即可作为系统提示词注入，无需改代码
- 📚 **RAG 知识库检索** —— 自动扫描、切片、向量化本地文档（支持 `.md/.txt/.pdf/.docx/.py/.json/...`），提问时按需检索相关片段注入上下文
- 🎭 **Skill 专属颜文字** —— 每个 Skill 可以在同级目录放 `emoji_config.json`，加载时自动生效；没加载 Skill 时 `[emo:xxx]` 原样显示
- ⚖️ **双模型对比** —— 同时问两个模型，并排展示回答
- 🌊 **流式输出** —— SSE 流式响应，带光标动画
- 🧠 **思考过程折叠** —— 自动识别 `deepseek-r1` 等模型的思考段并折叠展示
- 💬 **完整对话管理** —— 多会话、搜索、置顶、重命名、收藏消息、分支、编辑重发
- 🗜️ **上下文压缩** —— 早期消息一键压缩成摘要，节省 token
- 🎤 **语音输入 / 朗读** —— 基于浏览器 Web Speech API，零依赖
- 🎨 **主题 / 字号 / 主题色** 自定义，暗色 / 亮色切换
- 💾 **多格式导出** —— JSON / Markdown / TXT / 单条回答 / 全量备份恢复
- 🖥️ **纯本地运行** —— 无云端、无遥测、无账号

---

## 🏗️ 架构

```
┌─────────────────────────┐         ┌──────────────────────────┐
│   浏览器 (index.html)   │         │   Ollama (127.0.0.1:11434)│
│  - 聊天 UI / 流式渲染    │◄───────►│   /api/chat  对话         │
│  - Skill 下拉框          │         │   /api/tags  模型列表      │
│  - RAG 开关              │         │   /api/embeddings 向量     │
└───────────┬─────────────┘         └──────────────────────────┘
            │
            │ 加载 js/*.js 模块 + css/*.css
            ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  js/ 模块化前端         │         │  ChromaDB (本地持久化)    │
│  - state/utils/config   │         └──────────────────────────┘
│  - storage/session      │
│  - markdown/api         │
│  - ui/ + features/      │
│  - main.js (入口)       │
└───────────┬─────────────┘
            │ HTTP
            ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  rag_server.py (8000)   │◄───────►│   skills/  (SKILL.md)   │
│  - /api/skills          │         └──────────────────────────┘
│  - /api/skill_content   │
│  - /api/search  (RAG)   │
│  - /api/build   (建库)   │
└─────────────────────────┘
```

**工作流程**：

1. 浏览器加载 `index.html`，按顺序引入 `js/` 下 15 个模块
2. `main.js` 的 `init()` 启动 → 请求 `/api/skills` 拉取 Skill 列表 → 填充下拉框
3. 用户选择 Skill → 请求 `/api/skill_content` 获取 `SKILL.md` 和 `emoji_config.json` → 存为全局状态
4. 用户发消息（开启 RAG）→ 请求 `/api/search` 检索相关片段 → 拼接进 system prompt → 发给 Ollama
5. Ollama 流式返回 → 前端渲染（Markdown / 代码高亮 / KaTeX 公式 / 颜文字替换）
6. AI 回答落库时记录 `skillId` / `skillName`，消息头展示徽章

---

## 🚀 快速开始

### 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Python | 3.10+ | 后端运行环境 |
| Ollama | 最新版 | [下载地址](https://ollama.com/download) |
| 浏览器 | Chrome / Edge | 需要 Web Speech API 支持语音功能 |

### 2. 安装 Ollama 模型

```bash
# 对话模型（任选，建议至少一个 7B 中文能力强的）
ollama pull qwen2.5:7b

# 向量模型（RAG 必需，别漏了）
ollama pull nomic-embed-text
```

### 3. 克隆并安装依赖

```bash
git clone https://github.com/<your-name>/<your-repo>.git
cd <your-repo>

python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### 4. 配置

复制示例配置并修改：

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "skill_dir": "E:/skills",
  "ollama_url": "http://127.0.0.1:11434",
  "embed_model": "nomic-embed-text",
  "chunk_size": 600,
  "chunk_overlap": 100,
  "host": "127.0.0.1",
  "port": 8000,
  "safety_keywords": ["自杀", "自残", "想死"],
  "safety_fallback_path": ""
}
```

- `skill_dir`：你的 Skill 总目录（绝对路径或相对路径都可以）
- `safety_keywords`：可选，触发安全拦截的关键词，留空 `[]` 表示禁用
- `safety_fallback_path`：可选，触发安全拦截时返回的兜底文本文件

### 5. 启动

**方式 A：一键启动（Windows，推荐）**

双击 `启动狸猫AI.bat`。脚本会自动：

1. 检测 Python（未装则提示）
2. 检测 Ollama（未连上只警告）
3. 打开黑框跑 `rag_server.py`（端口 8000）
4. 打开黑框跑前端静态服务器（端口 5500）
5. 自动打开浏览器

**方式 B：手动启动**

```bash
# 终端 1：启动 Ollama（若服务未常驻）
ollama serve

# 终端 2：启动 RAG 秘书
python rag_server.py

# 终端 3：启动前端静态服务器
python -m http.server 5500
```

然后浏览器访问 `http://127.0.0.1:5500/index.html`。

看到如下后端输出即成功：

```
🚀 RAG 秘书启动中...
📂 配置文件: ...\config.json
📂 Skill 目录: E:/skills
📂 向量模型: nomic-embed-text @ http://127.0.0.1:11434
INFO:     Uvicorn running on http://127.0.0.1:8000
```

> ⚠️ **1.20 起前端已模块化拆分**，必须通过 HTTP 访问（不能双击 `file://` 打开 `index.html`）。

### 6. 建立知识库（首次使用必须做）

把要检索的文档放进 `skill_dir` 目录，**在前端界面点击左下角「⚙ 设置」->「知识库管理」->「🔄 重建知识库」**即可。

前端会显示实时进度条和当前处理的文件，完成后自动提示。

> ⚠️ **每次修改 `skill_dir` 下的任何文档后，点击一次「重建知识库」即可。得益于增量更新，未修改的文件会被极速跳过。**

---

## 📂 前端目录结构

1.20 起，前端从单文件拆分为模块化布局：

```
js/
├── state.js              # 全局状态变量（会话、UI 状态、Skill 状态等）
├── utils.js              # 通用工具（escapeHtml / estimateTokens / copyText 等）
├── config.js             # 默认配置、本地持久化、主题应用
├── storage.js            # 草稿 + IndexedDB + 文件夹同步
├── session.js            # 会话增删改查、搜索、重命名
├── markdown.js           # Markdown 渲染、思考分离、颜文字替换
├── api.js                # Ollama 请求 + RAG 检索
├── main.js               # 应用入口 init()
├── ui/
│   ├── sidebar.js        # 侧栏会话列表
│   ├── input.js          # 输入框、快捷模板、语音、快捷键
│   ├── settings.js       # 设置面板、预设、模板、颜文字列表
│   └── messages.js       # 消息渲染、消息导航、引用、朗读
└── features/
    ├── chat.js           # 对话核心（发送 / 重发 / 续写 / 重新生成 / 分支）
    ├── compress.js       # 上下文压缩
    └── export.js         # 导出 MD/TXT/JSON、备份恢复
```

加载顺序在 `index.html` 底部，共 15 个 `<script src="js/...">`，无打包、无构建。

---

## 🧩 Skill 格式

一个 Skill 就是一个包含 `SKILL.md` 的文件夹，放在 `skill_dir` 下（支持多层嵌套）：

```
E:/skills/
├── 对话skill狸猫/
│   └── 1.00/
│       ├── SKILL.md              ← 必需
│       ├── emoji_config.json     ← 可选，该 Skill 专属颜文字
│       └── references/           ← 可选，会被一起索引进 RAG
│           └── knowledge/
│               └── xxx.md
└── goutoujinshi/
    └── SKILL.md
```

### `SKILL.md` 推荐结构

```markdown
---
name: 狸猫
description: 一个温柔的情感陪伴角色
version: 1.00
---

# 角色设定

你是「狸猫」，一个...

## 说话风格

- ...

## 行为约束

- ...
```

- 顶部的 YAML front-matter 会被解析，`name` 字段会显示在下拉框里
- 没有 front-matter 也没关系，会用文件夹名代替
- 整个 `SKILL.md` 内容会**原样**作为系统提示词注入（优先级最高，覆盖设置里的系统提示词）

### `emoji_config.json` 格式（可选）

如果这个 Skill 想使用 `[emo:xxx]` 标签发送颜文字，就在同级目录放一个 JSON：

```json
{
  "nod": "( ˘•ω•˘ )",
  "smile": "(⌒▽⌒)",
  "sleepy": "( -_- )zzZ"
}
```

模型输出里出现 `[emo:nod]` 时，前端就会替换成 `( ˘•ω•˘ )`。

- 没加载 Skill 时，`[emo:xxx]` 会**原样显示**（不会被偷偷替换）
- 加载了没带 `emoji_config.json` 的 Skill，也保持原样
- 每个 Skill 可以有自己独立的一套颜文字

---

## 📖 API 接口

所有接口默认监听 `http://127.0.0.1:8000`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/` | 健康检查 |
| `GET`  | `/api/skills` | 扫描并返回所有 Skill 列表 |
| `GET`  | `/api/skill_content?skill_id=xxx` | 读取指定 Skill 的 `SKILL.md` 全文 + `emoji_config.json` |
| `GET`  | `/api/config` | 获取当前后端配置（如 skill_dir） |
| `POST` | `/api/config` | 动态修改并保存配置（如热更新 skill_dir） |
| `POST` | `/api/build` | 异步重建向量库（支持增量更新） |
| `GET`  | `/api/build_status` | 获取当前知识库构建的进度和状态 |
| `GET`  | `/api/search?query=xxx&top_k=3` | RAG 检索 |

交互式文档：启动后访问 <http://127.0.0.1:8000/docs>。

---

## ⚙️ 客户端设置

点开左下角「⚙ 设置」可以配置：

| 项目 | 说明 |
|---|---|
| Ollama 地址 | 默认 `http://127.0.0.1:11434` |
| RAG 后端地址 | 默认 `http://127.0.0.1:8000` |
| 知识库管理 | 一键重建向量库，带实时进度显示 |
| Skill 目录 | 动态修改并热重载 Skill 路径 |
| 并发对比开关 | 根据显卡性能选择双模型对比模式（串行/并行） |
| 存储目录 | 绑定本地文件夹，会话自动同步到 `conversations.json` |
| 系统提示词 | 未加载 Skill 时生效 |
| Temperature / Top P | 采样参数 |
| 上下文轮数 | 携带多少轮历史对话 |
| num_ctx / num_predict | Ollama 上下文窗口与最大输出 token |
| 字体大小 / 主题色 | 界面外观 |
| 提示词模板 | 输入框上方的快捷按钮 |
| 角色预设 | 本地保存的系统提示词预设 |

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Ctrl + N` | 新建对话 |
| `Ctrl + K` | 清空输入框 |
| `Ctrl + ,` | 打开设置 |
| `Esc` | 停止生成 / 取消引用 / 取消编辑 |

---

## 📁 目录结构

```
.
├── index.html                 # 前端骨架（190 行）+ 15 个 <script src>
├── css/                       # 5 个样式表
│   ├── base.css               # 变量、reset、主题
│   ├── layout.css             # 侧栏、顶栏、主布局
│   ├── chat.css               # 消息、思考框、代码块、对比
│   ├── input.css              # 输入区、快捷模板、语音
│   └── modal.css              # 弹窗、设置面板
├── js/                        # 15 个前端模块（见「前端目录结构」）
├── rag_server.py              # 后端 RAG 服务
├── 启动狸猫AI.bat              # 一键启动（1.20 新增）
├── 启动RAG秘书.bat             # 只启动后端
├── requirements.txt
├── config.example.json        # 配置模板
├── config.json                # 本地配置（已 .gitignore）
├── LICENSE
├── README.md
├── docs/                      # 项目文档
│   ├── 功能预览-1.20-1.21.txt
│   └── 交流群.txt
├── file_hashes.json           # 增量更新缓存（已 .gitignore）
└── chroma_db/                 # 向量库（自动生成，已 .gitignore）
```

---

## ❓ 常见问题

<details>
<summary><b>模型下拉框一直显示「加载中...」</b></summary>

1. 确认 Ollama 已启动：浏览器访问 <http://127.0.0.1:11434/api/tags> 是否返回 JSON
2. 确认至少拉了一个模型：`ollama list`
3. 检查设置里的「Ollama 地址」是否正确
</details>

<details>
<summary><b>RAG 检索不到内容 / 返回空</b></summary>

1. 确认已经执行过 `/api/build`
2. 检查 `config.json` 里的 `skill_dir` 是否正确
3. 看后端黑窗口有没有 `⚠️ 读取 xxx 失败` 之类的报错
4. 改过文档后忘了重建 —— 在前端点击「重建知识库」即可（会自动增量更新）
</details>

<details>
<summary><b>Skill 下拉框是空的</b></summary>

- 检查 `skill_dir` 下的文件夹里是否有 `SKILL.md`（文件名**大写**，区分大小写）
- 后端用的是 `os.walk` 递归扫描，多层目录也能找到
</details>

<details>
<summary><b>颜文字不显示 / 显示成 `[emo:xxx]`</b></summary>

- 检查 Skill 目录里是否有 `emoji_config.json`，且和 `SKILL.md` 同级
- 确认前端已经选择了那个 Skill（状态栏应显示"已加载 Skill: ... (颜文字 N)"）
- 没加载 Skill 时 `[emo:xxx]` 原样显示是**预期行为**
- **1.20 修复**：刷新页面后下拉框会保留上次选择，但 `onchange` 不会自动触发。现在已通过 `dispatchEvent` 修复，若仍遇到，手动切换一次即可
</details>

<details>
<summary><b>刷新后第一条消息没有 Skill 效果</b></summary>

见上一条。1.20 已修复。
</details>

<details>
<summary><b>浏览器报 CORS 错误 / 打开 `index.html` 白屏</b></summary>

- **1.20 起前端已模块化拆分，必须走 HTTP**，不能用 `file://` 双击打开
- 用 `python -m http.server 5500` 起静态服务器，访问 `http://127.0.0.1:5500/index.html`
- 或直接双击 `启动狸猫AI.bat`，它会自动帮你起服务器
</details>

<details>
<summary><b>7B 模型回答混乱 / 不遵守人设</b></summary>

这是**模型能力问题**，不是客户端问题。7B 模型在「保持人设 + 复杂指令 + 安全约束」三重冲突下经常崩溃。建议：
- 换 14B 及以上模型（如 `qwen2.5:14b`）
- 精简 Skill 的约束条目
- 或者把冲突约束拆到 RAG 分阶段注入
</details>

<details>
<summary><b>如何彻底清空向量库？</b></summary>

删除 `chroma_db/` 文件夹和 `file_hashes.json` 文件，重新点击「重建知识库」即可。
</details>

---

## 🔒 安全声明

- 本项目**仅监听 `127.0.0.1`**，默认不对外暴露。
- 后端接口**无鉴权**，请勿将 `host` 改为 `0.0.0.0` 后部署到公网。
- 如确有远程使用需求，请自行加 HTTPS + Token 鉴权 + 反向代理。

---

## 🗺️ Roadmap

### 已完成
- [x] 构建知识库时返回流式进度（1.19）
- [x] 前端模块化拆分（1.20）
- [x] Skill 加载记录（消息级字段 + UI 徽章 + 导出带上）（1.20）
- [x] 一键启动器 `启动狸猫AI.bat`（1.20）

### 1.20 剩余计划
- [ ] **F2** 多平台 API 接入（DeepSeek / OpenAI 兼容平台）
- [ ] **F7** 平台连通性检测
- [ ] **F8** 真实 token 用量显示
- [ ] **F4** 会话级 / 预设级模型参数覆盖
- [ ] **F5** 消息分支树状视图
- [ ] **F6** 拖拽文件到输入框（临时 RAG）
- [ ] **F1 v2** 切换会话自动恢复 Skill、重新生成时确认 Skill

### 1.21 计划
- [ ] 记忆系统（长期记忆）
- [ ] RAG 按 Skill 命名空间过滤
- [ ] 多 Skill 叠加
- [ ] 工具调用 / MCP 支持
- [ ] 视觉模型输入
- [ ] 更多文档格式（`.epub` / `.xlsx`）
- [ ] i18n（英文界面）

---

## 📜 License

[MIT](./LICENSE) © 2025 limaodawang

---

## 🙏 致谢

- [Ollama](https://ollama.com/) — 本地大模型运行时
- [ChromaDB](https://www.trychroma.com/) — 向量数据库
- [FastAPI](https://fastapi.tiangolo.com/) — 后端框架
- [marked](https://marked.js.org/) / [DOMPurify](https://github.com/cure53/DOMPurify) / [highlight.js](https://highlightjs.org/) / [KaTeX](https://katex.org/) — 前端渲染