# 狸猫AI工具盒 (Limaodawang AI Toolbox)

> 一个基于 Ollama 的本地大模型聊天客户端，支持 **多平台 API 接入**、**动态 Skill 加载**、**RAG 知识库检索**、**临时 RAG（拖拽文件）**、**长期记忆系统**、**多 Skill 组合** 与 **对话分支**。
> 前后端分离：模块化前端（原生 JS 多文件）+ 后端 Python (FastAPI + ChromaDB)。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)
![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-black.svg)
![Version](https://img.shields.io/badge/Version-1.22-green.svg)

---

## ✨ 特性

### 1.22 版本核心更新（重磅升级）

- 🔌 **多平台 API 接入** —— 打破只能用 Ollama 的限制，现支持任何 OpenAI 兼容接口（DeepSeek、Moonshot、SiliconFlow、OpenRouter 等），顶栏模型选择按平台分组展示，支持跨平台对比
- 🧠 **长期记忆系统** —— AI 自动从对话中提取你的偏好和事实，存入 `memory.json` 和独立向量库，下次对话按相关度自动注入，真正做到“记住你”
- 📎 **临时 RAG（拖拽文件）** —— 拖拽文件到输入框或点击回形针上传，文本文件（.md/.txt/.py/.html/.json 等）由前端直接读取，PDF/Word 走后端解析，**不落库、不污染主知识库**，仅本次对话生效
- 📡 **平台连通性检测** —— 设置面板新增“平台管理”，可添加/编辑/删除平台，并一键测试连接
- 📊 **真实 Token 统计** —— 接入外部 API 后，消息头显示真实的 prompt / completion token 用量

### 1.21 版本功能

- 👀 **文件自动监听** —— 后端启动后自动盯着 `skill_dir`，改文件后 2 秒内自动增量重建向量库
- 🧩 **多 Skill 叠加** —— 下拉框多选，system prompt 按顺序拼接，颜文字库自动合并
- 🔍 **Skill 命名空间隔离** —— 每个 Skill 的知识库独立检索，避免跨 Skill 文档污染
- 🎯 **相关度百分比** —— RAG 引用改用 cosine 距离，显示 0~100% 相关度标签
- 📂 **引用可交互** —— 每条引用支持展开全文、复制、一键打开所在目录
- 🌿 **消息分支树** —— 任意 AI 回答可“分叉”，顶栏显示面包屑，侧栏显示层级缩进
- 🌡️ **三级参数继承** —— 全局 → 预设 → 会话，每个对话独立配置 temperature/num_ctx 等
- 📝 **模板变量** —— 提示词模板支持 `{{date}}`、`{{clipboard}}`、`{{selected}}` 等变量

### 1.20 版本功能

- 🧱 **前端模块化** —— 3000 行单文件拆为 15 个 JS + 5 个 CSS
- 🧩 **Skill 加载追溯** —— 每条 AI 回答记录 Skill 来源，导出时带上
- 🚀 **一键启动器** —— `启动狸猫AI工具盒.bat` 自动检测环境并拉起前后端

### 1.18 ~ 1.19 首发功能

- 🧩 **动态 Skill 加载** —— 把 `SKILL.md` 放进 `skills/` 目录，下拉框选中即生效
- 🎭 **Skill 专属颜文字** —— 每个 Skill 配 `emoji_config.json`，`[emo:xxx]` 自动替换
- ⚖️ **双模型对比** —— 并发 / 串行可选
- 🌊 **流式输出 + 思考过程折叠**
- 💬 **完整对话管理** —— 多会话、搜索、置顶、收藏、分支、编辑重发
- 🗜️ **上下文压缩** —— 早期消息一键压缩成摘要
- 🎤 **语音输入 / 朗读** —— 基于 Web Speech API
- 🎨 **主题 / 字号 / 主题色** 自定义
- 💾 **多格式导出** —— JSON / Markdown / TXT / 单条回答 / 全量备份
- 📚 **RAG 知识库检索** —— 一键重建 + 增量更新（按文件 MD5 判断）
- 🖥️ **纯本地运行** —— 无云端、无遥测、无账号

---

## 🏗️ 架构

```
┌─────────────────────────┐         ┌──────────────────────────┐
│   浏览器 (index.html)   │         │   Ollama (127.0.0.1:11434)│
│  - 聊天 UI / 流式渲染    │◄───────►│   /api/chat  对话         │
│  - Skill 单选 / 多选     │         │   /api/tags  模型列表      │
│  - RAG 开关 / 引用展示   │         │   /api/embeddings 向量     │
│  - 拖拽文件 / 点击上传   │         └──────────────────────────┘
└───────────┬─────────────┘
            │
            │ 加载 js/*.js 模块 + css/*.css
            ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  js/ 模块化前端         │         │  ChromaDB (cosine 距离)   │
│  - state/config/utils   │         │  - skill_knowledge 集合   │
│  - storage/session      │         │  - user_memory 集合       │
│  - markdown/api         │         │  - 按 skill_id 隔离检索   │
│  - ui/ + features/      │         └──────────────────────────┘
│  - main.js (入口)       │
└───────────┬─────────────┘
            │ HTTP
            ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  rag_server.py (8000)   │◄───────►│   skills/  (SKILL.md)   │
│  - /api/skills          │         │   + emoji_config.json   │
│  - /api/skill_content   │         └──────────────────────────┘
│  - /api/search  (RAG)   │
│  - /api/build   (建库)   │         ┌──────────────────────────┐
│  - /api/memory/* (记忆)  │◄───────►│  memory.json (长期记忆)   │
│  - /api/parse_temp_file │         └──────────────────────────┘
│  - /api/open_folder     │
│  - /api/embed           │         ┌──────────────────────────┐
└─────────────────────────┘◄───────►│  watchdog 文件监听线程    │
                                    └──────────────────────────┘
```

**工作流程：**

1. 浏览器加载 `index.html`，按顺序引入 `js/` 下 15 个模块
2. `main.js` 的 `init()` 启动 → 拉取 Skill 列表 → 恢复上次选择的 Skill → 绑定拖拽上传
3. 用户发消息 → 按当前 Skill 命名空间检索 → 拼接 system prompt → 发给所选平台的模型
4. AI 流式返回 → 前端渲染（Markdown / 代码高亮 / KaTeX / 颜文字替换）
5. 回答完毕后，后台静默从对话中提取记忆并存入 `memory.json` 和向量库
6. 后端 watchdog 盯着 `skill_dir`，有文件变化 → 2 秒后自动增量重建

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
git clone https://github.com/lililillmao/limaodawang-chat-rag.git
cd limaodawang-chat-rag

python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

> ⚠️ **1.22 新增依赖**：`python-multipart`（用于接收前端上传的临时文件）。如果你的 `requirements.txt` 里还没有它，请手动加上。

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

- `skill_dir`：你的 Skill 总目录
- `safety_keywords`：可选，触发安全拦截的关键词
- `safety_fallback_path`：可选，触发安全拦截时返回的兜底文本文件

### 5. 启动

**方式 A：一键启动（Windows，推荐）**

双击 `一键启动狸猫ai工具盒.bat`。脚本会自动：

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

成功启动时后端输出类似：

```
🚀 RAG 秘书启动中...
📂 配置文件: ...\config.json
📂 Skill 目录: E:/skills
📂 向量模型: nomic-embed-text @ http://127.0.0.1:11434
📂 知识库现有: 658 个片段
📂 记忆库现有: 0 条记忆
👀 文件监听: 已启用
👀 已启动文件监听：E:/skills
INFO:     Uvicorn running on http://127.0.0.1:8000
```

> ⚠️ **1.20 起前端已模块化拆分**，必须通过 HTTP 访问（不能双击 `file://` 打开 `index.html`）。

### 6. 建立知识库（首次使用必须做）

把要检索的文档放进 `skill_dir` 目录，**在前端界面点击「⚙ 设置」→「🔄 重建知识库」** 即可。

**之后修改任何文档，watchdog 会自动检测并增量更新，无需再手动点按钮。**

### 7. 配置多平台（可选）

1. 打开「⚙ 设置」→「平台管理」
2. 点击「＋ 新增平台」
3. 填写：
   - 名称：`DeepSeek`
   - API 地址：`https://api.deepseek.com`
   - 类型：`openai`
   - API Key：你的 DeepSeek 密钥
4. 点击「测试连接」，确认连通
5. 关闭设置，顶栏模型下拉框会按平台分组展示所有模型

---

## 🧠 长期记忆系统

### 如何使用

- **自动提取**：每次 AI 回答完毕后，后台会静默分析最近对话，自动提取关于你的关键信息（姓名、喜好、习惯等），存入 `memory.json` 和向量库
- **手动添加**：设置面板 →「🧠 长期记忆」→ 输入内容 →「＋ 添加」
- **自动注入**：下次对话时，系统按相关度检索记忆并注入上下文，AI 回答底部会显示 `🧠 记忆` 引用
- **开关控制**：设置面板顶部可勾选「启用记忆注入」，关闭后不再注入

### 记忆存储位置

- `memory.json`：记忆的元数据（内容、来源、时间、启用状态）
- `chroma_db/` 中的 `user_memory` 集合：记忆的向量表示，用于相似度检索

---

## 📎 临时 RAG（拖拽文件）

### 如何使用

- **拖拽上传**：将文件拖到页面任意位置，出现全屏提示后松开，文件会变成输入框上方的 Chip 标签
- **点击上传**：点击输入框右侧的 📎 回形针按钮，选择文件
- **移除文件**：点击 Chip 上的 `×` 可移除单个临时文件

### 支持格式

| 文件类型 | 处理方式 | 说明 |
|---|---|---|
| `.md` `.txt` `.py` `.html` `.css` `.js` `.json` `.csv` `.xml` `.yaml` | 前端直接读取 | 浏览器原生 `file.text()` 读取，100% 兼容 |
| `.pdf` `.docx` | 后端解析 | 调用 `pypdf` / `python-docx` 提取文本 |

### 工作原理

临时文件**不会写入 ChromaDB 主知识库**，而是：
1. 文本文件由前端直接读取并切片
2. 发送消息时，将文件内容**全文注入**到 system prompt 中
3. 对话结束或刷新页面后自动清空

---

## 📂 前端目录结构

```
js/
├── state.js              # 全局状态变量
├── utils.js              # 通用工具（含模板变量解析、分支树辅助）
├── config.js             # 默认配置、本地持久化、参数三级继承
├── storage.js            # 草稿 + IndexedDB + 文件夹同步
├── session.js            # 会话增删改查、搜索、分支面包屑
├── markdown.js           # Markdown 渲染、思考分离、颜文字替换
├── api.js                # 多平台请求 + RAG 检索 + 临时文件 + 记忆接口
├── main.js               # 应用入口 init() + Skill 组合 + 构建轮询
├── ui/
│   ├── sidebar.js        # 侧栏会话列表（含分支缩进）
│   ├── input.js          # 输入框、快捷模板、语音、拖拽上传
│   ├── settings.js       # 设置面板、预设、模板、颜文字、平台管理、记忆管理
│   └── messages.js       # 消息渲染、RAG 引用卡片、消息导航、朗读
└── features/
    ├── chat.js           # 对话核心（发送 / 重发 / 续写 / 分叉 / 记忆提取）
    ├── compress.js       # 上下文压缩
    └── export.js         # 导出 MD/TXT/JSON、备份恢复
```

加载顺序在 `index.html` 底部，共 15 个 `<script src="js/...">`，无打包、无构建。

---

## 🧩 Skill 格式

一个 Skill 就是一个包含 `SKILL.md` 的文件夹，放在 `skill_dir` 下（支持多层嵌套）：

```
E:/skills/
├── 狸猫测试官/
│   ├── SKILL.md              ← 必需
│   ├── emoji_config.json     ← 可选，该 Skill 专属颜文字
│   └── references/           ← 可选，会被一起索引进 RAG
│       └── knowledge/
│           └── xxx.md
└── goutoujushi/
    └── SKILL.md
```

### `SKILL.md` 推荐结构

```markdown
---
name: 狸猫
description: 一个温柔的情感陪伴角色
version: 1.00
rag_scope: self
---

# 角色设定

你是「狸猫」，一个...

## 说话风格

- ...

## 行为约束

- ...
```

- `name` 字段会显示在下拉框里；没有 front-matter 就用文件夹名
- **`rag_scope`** 可选值：
  - `self`（默认）：检索时只搜这个 Skill 目录下的文档
  - `all`：检索时搜全库
- 整个 `SKILL.md` 内容会**原样**作为系统提示词注入（优先级最高）

### `emoji_config.json` 格式（可选）

```json
{
  "nod": "( ˘•ω•˘ )",
  "smile": "(⌒▽⌒)",
  "sleepy": "( -_- )zzZ"
}
```

模型输出 `[emo:nod]` 时前端自动替换成 `( ˘•ω•˘ )`。

---

## 📖 API 接口

所有接口默认监听 `http://127.0.0.1:8000`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/` | 健康检查（含 watchdog 状态） |
| `GET`  | `/api/skills` | 扫描并返回所有 Skill 列表（含 `rag_scope`） |
| `GET`  | `/api/skill_content?skill_id=xxx` | 读取指定 Skill 的 `SKILL.md` + `emoji_config.json` + `rag_scope` |
| `GET`  | `/api/config` | 获取当前后端配置 |
| `POST` | `/api/config` | 动态修改配置（热重载 skill_dir + 重启监听） |
| `POST` | `/api/build` | 异步重建向量库（增量） |
| `GET`  | `/api/build_status` | 获取构建进度和触发来源 |
| `GET`  | `/api/search?query=xxx&top_k=3&skill_id=xxx&scope=self` | RAG 检索（支持命名空间隔离） |
| `POST` | `/api/open_folder` | 在文件管理器中打开并选中文件 |
| `POST` | `/api/embed` | 获取文本向量（用于临时 RAG） |
| `POST` | `/api/parse_temp_file` | 解析上传的临时文件（PDF/Word 走后端） |
| `GET`  | `/api/memory/list` | 获取所有长期记忆 |
| `POST` | `/api/memory/add` | 添加一条记忆 |
| `POST` | `/api/memory/delete` | 删除一条记忆 |
| `GET`  | `/api/memory/search?query=xxx&top_k=3` | 检索记忆 |

交互式文档：启动后访问 <http://127.0.0.1:8000/docs>。

---

## ⚙️ 客户端设置

点开左下角「⚙ 设置」可以配置：

| 项目 | 说明 |
|---|---|
| 平台管理 | 添加/编辑/删除 Ollama、DeepSeek 等平台，支持一键测试连接 |
| 知识库管理 | 一键重建向量库（增量），带实时进度 |
| Skill 目录 | 动态修改并热重载，同时重启文件监听 |
| 并发对比开关 | 根据显卡性能选择双模型对比模式 |
| 存储目录 | 绑定本地文件夹，会话自动同步到 `conversations.json` |
| 长期记忆 | 启用/禁用记忆注入，查看/添加/删除记忆 |
| 系统提示词 | 未加载 Skill 时生效 |
| Temperature / Top P / num_ctx / num_predict | 全局参数（可被预设或会话覆盖） |
| 字体大小 / 主题色 | 界面外观 |
| 提示词模板 | 输入框上方的快捷按钮，支持 `{{date}}` 等变量 |
| 角色预设 | 本地保存的系统提示词预设，可附带参数覆盖 |

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
├── index.html                 # 前端骨架 + 15 个 <script src>
├── css/                       # 5 个样式表
│   ├── base.css               # 变量、reset、主题
│   ├── layout.css             # 侧栏、顶栏、面包屑
│   ├── chat.css               # 消息、思考框、代码块、RAG 引用卡片
│   ├── input.css              # 输入区、快捷模板、语音、拖拽上传
│   └── modal.css              # 弹窗、设置、Skill 组合、参数面板
├── js/                        # 15 个前端模块
├── rag_server.py              # 后端 RAG 服务（含 watchdog + 记忆系统）
├── 一键启动狸猫ai工具盒.bat     # 一键启动
├── 启动RAG秘书.bat             # 只启动后端
├── requirements.txt
├── config.example.json        # 配置模板
├── config.json                # 本地配置（.gitignore）
├── memory.json                # 长期记忆数据（.gitignore）
├── LICENSE
├── README.md
├── docs/
│   └── CHANGELOG.md
├── file_hashes.json           # 增量更新缓存（.gitignore）
└── chroma_db/                 # 向量库（.gitignore）
```

---

## ❓ 常见问题

<details>
<summary><b>模型下拉框一直显示「加载中...」</b></summary>

1. 确认 Ollama 已启动：浏览器访问 <http://127.0.0.1:11434/api/tags> 是否返回 JSON
2. 确认至少拉了一个模型：`ollama list`
3. 检查设置里的「Ollama 地址」是否正确
4. 如果接入了外部平台，检查 API Key 是否有效（可点「测试连接」验证）
</details>

<details>
<summary><b>RAG 检索不到内容 / 返回空</b></summary>

1. 确认已经执行过"重建知识库"（或 watchdog 已自动建过）
2. 检查 `config.json` 里的 `skill_dir` 是否正确
3. 看后端黑窗口有没有 `⚠️ 读取 xxx 失败` 之类的报错
4. **如果向量库为空但哈希缓存存在**：1.21 起会自动检测并全量重建
5. 如果之前删过 `chroma_db` 但 `file_hashes.json` 还在，也可以直接删 `file_hashes.json` 后重启
</details>

<details>
<summary><b>相关度全是 1%</b></summary>

旧版向量库用的是 L2 距离，1.21 起改用 cosine 距离。**解决方法**：删除 `chroma_db` 文件夹和 `file_hashes.json`，重启后端，会自动全量重建。
</details>

<details>
<summary><b>拖拽文件没反应 / 浏览器直接打开了文件</b></summary>

1. 确认 `js/ui/input.js` 中的 `bindDragAndDrop()` 函数存在，且 `js/main.js` 的 `init()` 中调用了 `bindDragAndDrop();`
2. 按 `Ctrl + F5` 强制刷新页面（清除浏览器旧缓存）
3. 拖拽时请拖到**输入框区域**，不要拖到浏览器标签页上
</details>

<details>
<summary><b>临时文件拖进去但 AI 读不到内容</b></summary>

1. 确认文件大小不超过 5MB
2. 文本文件（.md/.txt/.py/.html/.json 等）由前端直接读取，如果编码不是 UTF-8，可能显示乱码
3. 查看浏览器 F12 控制台是否有报错
4. 临时文件内容超过 3000 字会被截断，这是正常的（防止爆 token）
</details>

<details>
<summary><b>记忆功能不生效</b></summary>

1. 确认设置面板中「启用记忆注入」已勾选
2. 确认后端 `rag_server.py` 已重启，黑框中显示 `📂 记忆库现有: xxx 条记忆`
3. 打开设置面板 →「🧠 长期记忆」，查看是否有记忆条目
4. 如果记忆库为空，先手动添加一条测试
5. 确认 `python-multipart` 已安装（`pip list` 查看）
</details>

<details>
<summary><b>Skill 下拉框是空的</b></summary>

- 检查 `skill_dir` 下的文件夹里是否有 `SKILL.md`（文件名**大写**，区分大小写）
- 后端用的是 `os.walk` 递归扫描，多层目录也能找到
</details>

<details>
<summary><b>颜文字不显示 / 显示成 `[emo:xxx]`</b></summary>

- 检查 Skill 目录里是否有 `emoji_config.json`，且和 `SKILL.md` 同级
- 确认前端已经选择了那个 Skill
- **多 Skill 组合时**，emoji 库是合并的，同名的以后加载的为准
</details>

<details>
<summary><b>浏览器报 CORS 错误 / 打开 `index.html` 白屏</b></summary>

- **1.20 起前端已模块化拆分，必须走 HTTP**，不能用 `file://` 双击打开
- 用 `python -m http.server 5500` 起静态服务器
- 或直接双击 `一键启动狸猫ai工具盒.bat`
</details>

<details>
<summary><b>如何彻底清空向量库？</b></summary>

删除 `chroma_db/` 文件夹和 `file_hashes.json` 文件，重启后端会自动全量重建。
</details>

---

## 🔒 安全声明

- 本项目**仅监听 `127.0.0.1`**，默认不对外暴露。
- 后端接口**无鉴权**，请勿将 `host` 改为 `0.0.0.0` 后部署到公网。
- API Key 明文存储在 `localStorage` 中，请勿在公共电脑上保存敏感密钥。
- 如确有远程使用需求，请自行加 HTTPS + Token 鉴权 + 反向代理。

---

## 🗺️ Roadmap

### 已完成

- [x] 构建知识库返回流式进度（1.19）
- [x] 前端模块化拆分（1.20）
- [x] Skill 加载记录与追溯（1.20）
- [x] 一键启动器（1.20）
- [x] 会话级 / 预设级模型参数（1.21）
- [x] 消息分支树状视图（1.21）
- [x] 提示词模板变量（1.21）
- [x] RAG 引用可点击跳转 + 相关度显示（1.21）
- [x] Skill 命名空间隔离（1.21）
- [x] 多 Skill 叠加（1.21）
- [x] 文件自动监听（1.21）
- [x] 多平台 API 接入（1.22）
- [x] 平台连通性检测（1.22）
- [x] 真实 Token 统计（1.22）
- [x] 临时 RAG（拖拽文件）（1.22）
- [x] 长期记忆系统（1.22）

### 未来计划

- [ ] 工具调用 / MCP 支持
- [ ] 视觉模型输入（拖拽图片）
- [ ] 从 ChatGPT / Claude 导入历史
- [ ] 数据加密
- [ ] 成本统计
- [ ] 插件市场

---

## 📜 License

[MIT](./LICENSE) © 2025 limaodawang

---

## 🙏 致谢

- [Ollama](https://ollama.com/) — 本地大模型运行时
- [ChromaDB](https://www.trychroma.com/) — 向量数据库
- [FastAPI](https://fastapi.tiangolo.com/) — 后端框架
- [watchdog](https://github.com/gorakhargosh/watchdog) — 文件系统监听
- [marked](https://marked.js.org/) / [DOMPurify](https://github.com/cure53/DOMPurify) / [highlight.js](https://highlightjs.org/) / [KaTeX](https://katex.org/) — 前端渲染