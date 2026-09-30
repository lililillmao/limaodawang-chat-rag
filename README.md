# 狸猫AI工具盒 (Limaodawang AI Toolbox)

> 一个基于 Ollama 的本地大模型聊天客户端，支持 **多平台 API 接入**、**动态 Skill 加载**、**RAG 知识库检索**、**临时 RAG（拖拽文件）**、**视觉输入（拖拽图片）**、**工具调用**、**长期记忆系统**、**多 Skill 组合**、**对话分支** 与 **成本统计**。
> 前后端分离：模块化前端（原生 JS 多文件）+ 后端 Python (FastAPI + ChromaDB)。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)
![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-black.svg)
![Version](https://img.shields.io/badge/Version-1.23.1-green.svg)

---

## ✨ 特性

### 1.23.1 稳定性补丁

- 🐛 **修复 ChatGPT 分叉对话导入串线** —— `findImportLongestChain` 的叶子判定逻辑写反了（`hasChild` 装的是"子节点"而不是"有子节点的自己"），导致 `current_node` 缺失时会退化成按时间排序、把被放弃的支路也混进来。本次真正修对了。
- 🐛 **修复工具调用后 AI 回答闪烁原始返回值** —— `streamUpdate` 用 `s.messages[length-1]` 取当前消息，但工具结果消息（`role:"tool"`，隐藏不渲染）会被 push 到数组末尾，导致每帧把工具结果 JSON 渲染进 AI 气泡。改为从 `wrap.dataset.idx` 反查真正的消息。
- 🐛 **修复后端在非 Windows 系统下的无限重建循环** —— watchdog 的忽略正则把路径分隔符硬编码成 `\\`，Linux / macOS 下的 `chroma_db/` 匹配不到，导致自触发重建。
- 🐛 **修复 `split_text` 在 `chunk_overlap >= chunk_size` 时死循环** —— 现在会自动兜底（`step` 至少为 1），并对 0 / 负数参数做防御。
- 🐛 **修复角色预设从未生效** —— `currentPresetId` 全项目没有任何赋值点，预设级 system prompt 和参数覆盖全部失效。新增 `setActivePreset` / `restoreActivePreset`，并加了顶栏徽章。
- 🐛 **补全 `/api/emoji` 路由** —— 前端 `resetEmo` 一直在请求，但后端从没有这个路由（404）。
- 🐛 **修复 `memory.json` 损坏时的静默数据丢失** —— 原来读-改-写完全无锁、非原子保存，两个请求交错会互相覆盖。现在加了模块级锁 + `os.replace` 原子替换 + 损坏文件先备份为 `.bad`。
- 🐛 **修复 `add_memory` 毫秒级 ID 碰撞** —— 加随机后缀并检查现有 ID。
- 🐛 **修复 `run_build_task` 异常后卡在 `running`** —— 加 `try/finally` 兜底，异常时状态重置为 `failed` 并记录 `last_error`。
- 🐛 **扩展 `read_file_content` 白名单** —— `.yaml/.yml/.xml/.sh/.toml/LICENSE/README` 等此前会被静默漏索引（hash 记录了但零向量），现在补全。
- 🐛 **`find_skill_root` 支持根目录 `SKILL.md`** —— 放在 `skill_dir` 根目录的文件此前归属不到根级 Skill。
- 🐛 **`parse_rag_scope` 接受带引号和 BOM 的值** —— `rag_scope: "all"` 此前会静默退化成 `self`。
- 🐛 **`parse_temp_file` 缺少 filename 时正确返回 4xx** —— 此前可能因 `os.path.splitext(None)` 抛 500。
- 🐛 **watchdog 过滤事件类型** —— 忽略 `opened` / `closed` 事件，避免"构建读文件 → 触发重建 → 再读文件"的自我维持循环。
- 🐛 **`/api/build` 的"判断 running + 置 running"改为锁内原子操作** —— 避免并发请求各起一个构建线程。
- 🔧 **测试套件扩展** —— 新增 `test_backend.py`（116 项断言，含沙箱机制不污染真实数据）；前端集成测试扩展到 125 项。

### 1.23 版本核心更新

- 📊 **成本统计** —— 消息头显示**真实** prompt / completion token 用量与单条费用，顶栏「📊」打开统计面板：按平台 / 模型 / 日期聚合，纯 SVG 柱状趋势图，支持导出 CSV（带 BOM，Excel 不乱码）
- 🖼️ **视觉输入（多模态）** —— 拖拽、点击回形针、或**直接 Ctrl+V 粘贴截图**，图片在本地压缩（默认最长边 1568px、转 JPEG）后随消息发送；消息内可点击放大；同时支持 Ollama 的 `images` 与 OpenAI 的 `image_url` 两套格式
- 🔧 **工具调用（function calling）** —— 模型可主动调用 5 个**本地只读**工具：检索知识库、读取当前时间、精确计算、列出 Skill、读取会话状态；多轮调用（默认上限 5 轮，可调）、调用过程以折叠卡片展示参数与结果
- ↥ **导入 ChatGPT / Claude 历史** —— 上传官方导出的 `conversations.json`，自动识别格式、还原 ChatGPT 的对话树、预览并按会话勾选、疑似重复自动标记，导入前预估存储占用，**配额不足时自动回滚**，绝不破坏现有对话

### 1.22 版本核心更新（重磅升级）

- 🔌 **多平台 API 接入** —— 打破只能用 Ollama 的限制，现支持任何 OpenAI 兼容接口（DeepSeek、Moonshot、SiliconFlow、OpenRouter 等），顶栏模型选择按平台分组展示，支持跨平台对比
- 🧠 **长期记忆系统** —— AI 自动从对话中提取你的偏好和事实，存入 `memory.json` 和独立向量库，下次对话按相关度自动注入，真正做到"记住你"
- 📎 **临时 RAG（拖拽文件）** —— 拖拽文件到输入框或点击回形针上传，文本文件（.md/.txt/.py/.html/.json 等）由前端直接读取，PDF/Word 走后端解析，**不落库、不污染主知识库**，仅本次对话生效
- 📡 **平台连通性检测** —— 设置面板新增"平台管理"，可添加/编辑/删除平台，并一键测试连接
- 📊 **真实 Token 统计** —— 接入外部 API 后，消息头显示真实的 prompt / completion token 用量

### 1.21 版本功能

- 👀 **文件自动监听** —— 后端启动后自动盯着 `skill_dir`，改文件后 2 秒内自动增量重建向量库
- 🧩 **多 Skill 叠加** —— 下拉框多选，system prompt 按顺序拼接，颜文字库自动合并
- 🔍 **Skill 命名空间隔离** —— 每个 Skill 的知识库独立检索，避免跨 Skill 文档污染
- 🎯 **相关度百分比** —— RAG 引用改用 cosine 距离，显示 0~100% 相关度标签
- 📂 **引用可交互** —— 每条引用支持展开全文、复制、一键打开所在目录
- 🌿 **消息分支树** —— 任意 AI 回答可"分叉"，顶栏显示面包屑，侧栏显示层级缩进
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
│  - /api/emoji           │
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

1. 浏览器加载 `index.html`，按顺序引入 `js/` 下 18 个模块
2. `main.js` 的 `init()` 启动 → 拉取 Skill 列表 → 恢复上次选择的 Skill / 预设 → 绑定拖拽上传
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

### 数据安全（1.23.1 新增）

- **原子写入**：先写 `memory.json.tmp` 再 `os.replace`，避免写一半崩溃留下截断文件
- **损坏自动备份**：如果 `memory.json` 因为意外（磁盘满、进程被杀、断电）被写坏，后端会**先把它重命名为 `memory.json.bad`** 保留一份，再按"空记忆"继续运行——**绝不静默当成空数组**（那样下一次写入会永久抹掉旧数据）
- **并发锁**：所有"读-改-写"操作都在模块级锁内完成，两个请求交错不会互相覆盖

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
3. **发送后即清空**（1.23.1 修复），不会反复注入到后续每一条消息

---

## 🖼️ 视觉输入（多模态）

### 如何使用

- **拖拽**：把图片拖到页面任意位置松开（与拖文档互不干扰，会自动分流）
- **点击**：点击输入框右侧的 📎 回形针，选择图片
- **粘贴**：截图后直接在输入框按 `Ctrl + V`
- **查看**：发送后消息里显示缩略图，**点击可放大**；输入框上方的缩略图 chip 可单独删除

### 支持的平台与格式

| 平台类型 | 消息体格式 | 说明 |
|---|---|---|
| Ollama | `message.images = [base64]` | 需模型支持视觉，如 `llama3.2-vision`、`llava`、`qwen2-vl`、`minicpm-v` |
| OpenAI 兼容 | `content: [{type:"text"},{type:"image_url"}]` | 如 `gpt-4o`、`qwen-vl-max`、`glm-4v` |

### 图片处理策略

1. 发送前在**浏览器本地**用 canvas 压缩：最长边默认缩到 1568px，转 JPEG，质量从 0.85 逐档降到满足体积上限
2. 一次最多附带 **6 张**，单张原图上限 12MB
3. GIF 不做重编码（避免丢帧）
4. 存储在浏览器 localStorage 中，会占用约 5MB 的配额，建议及时清理不需要的对话
5. 可在「⚙ 设置 → 🖼️ 视觉输入」关闭该功能或调整最长边上限
6. **纯图片消息**（不打字只贴图）也能发送——1.23.1 修复，此前会被直接吞掉

> ⚠️ 图片输入需要**多模态模型**。用纯文本模型发图片，模型会忽略图片内容（不会报错，但看不到图）。

---

## 🔧 工具调用（function calling）

### 如何使用

1. 顶栏点「🔧 工具」开关（徽章显示「开」）
2. **右键**该按钮（或在设置面板里）可查看当前注册的工具清单
3. 正常提问即可，模型在需要时会自动请求调用，调用过程以折叠卡片显示在回答上方，含工具名、参数、结果与耗时

### 内置工具（全部只读、无副作用）

| 工具名 | 显示名 | 作用 |
|---|---|---|
| `rag_search` | 检索知识库 | 在本地知识库中检索相关片段（复用 RAG 后端） |
| `get_current_time` | 读取当前时间 | 模型本身无法得知"现在几点" |
| `calculator` | 计算器 | 精确四则运算，支持 `+ - * / % ( ) ^` |
| `list_skills` | 列出可用 Skill | 列出当前配置的所有 Skill |
| `get_session_info` | 读取会话信息 | 返回当前对话的模型、开关、消息数等状态 |

### 安全设计

- 工具**全部在浏览器本地执行**，不经过 Python 后端，不引入新的鉴权面
- 只注册**只读**工具，**不提供**任何写文件、执行命令的能力
- 计算结果使用**手写递归下降解析器**，不使用 `eval` / `new Function`（模型输出是不可信输入）
- 单次工具结果超过 4000 字会截断，防止撑爆上下文
- **多轮上限**默认 5 轮（设置面板可调 1~20），达到上限会明确提示而不是静默停止
- 工具调用过程中点「停止」会立即中断，不会继续下一轮
- **1.23.1 修复**：工具调用时 AI 回答气泡不再闪烁工具原始返回值；token 用量按**各轮累加**而不是取最后一轮

> ⚠️ Ollama 的部分模型对 tool calling 支持参差不齐。若开启后出现报错或回答异常，关掉开关即可完全恢复原有行为（默认关闭）。

---

## 📊 成本统计

### 如何使用

顶栏点「📊」打开统计面板：

- **汇总卡片**：总调用次数、总 prompt / completion token、总费用
- **时间范围**：近 7 天 / 近 30 天 / 近 90 天 / 全部
- **分组维度**：按平台 / 按模型 / 按日期
- **趋势图**：纯 SVG 柱状图，可切换「调用次数 / token 总量」
- **导出 CSV**（带 UTF-8 BOM，Excel 打开不乱码）
- **清空统计**（二次确认）

消息头也会显示**单条**费用徽章（如 `💰 $0.0032`），本地模型显示 `💰 本地免费`。

### 数据从哪来

| 平台 | 数据来源 | 说明 |
|---|---|---|
| OpenAI 兼容 | 请求体加 `stream_options: {include_usage: true}`，读取 `usage` 字段 | 真实值 |
| Ollama | 读取流最后一帧的 `prompt_eval_count` / `eval_count` | 真实值 |

> 1.22 及以前这两个来源都没有接通（OpenAI 未开 `include_usage`、Ollama 的 `eval_count` 被直接丢弃），所以"真实 Token 统计"实际上拿不到数据。1.23 一并修复了。

**只记真实值**：如果某个平台/模型没有返回用量，就**不记账**，不会用估算值污染统计。历史消息没有真实用量时，消息头仍显示 `≈ N token`（估算），并**不显示**费用徽章。

### 费用估算

- 内置常见模型参考价表（DeepSeek / OpenAI / Claude / Moonshot / Qwen / GLM / Gemini），可在 `js/features/stats.js` 顶部 `USAGE_PRICE_TABLE` 自行修改
- 单位：美元 / 每百万 token；价格是**参考值**，请以各平台官网为准
- **本地 Ollama 模型成本恒为 0**，标记为「本地免费」
- 云端模型若不在价格表内且费用为 0，**不显示**费用徽章（避免误导成免费）

### 存储

- `chat_usage`（localStorage）：按「日期 → 平台|模型」二级索引的聚合数据，O(1) 累加
- `chat_usage_log`（localStorage）：明细日志，**上限 5000 条**，超出从头部滚动删除
- 写入有 800ms 节流；页面隐藏 / 关闭时会强制落盘，避免丢最后一次记账
- 不放进 `cfg`，也不混进 `chat_sessions`（后者每次保存都全量序列化，会被拖慢）

---

## ↥ 导入 ChatGPT / Claude 历史

### 如何使用

1. 侧栏点「↥ 导入历史」
2. 选择：
   - **ChatGPT**：官方导出包里的 `conversations.json`
   - **Claude**：官方导出包里的 `conversations.json`
3. 预览面板会显示识别到的格式、会话数、可导入数、跳过数、消息总数、时间范围
4. 逐条勾选要导入的会话（支持「全选 / 全不选 / 只选非重复」）
5. 点「导入所选」

### 解析能力

| 项目 | ChatGPT | Claude |
|---|---|---|
| 结构 | `mapping` 对话**树**，从 `current_node` 沿 `parent` 回溯成线性 | `chat_messages` 线性数组 |
| 分支处理 | 只走当前分支，放弃其它分支 | 不适用 |
| 时间 | Unix **秒**（含小数）→ 毫秒 | ISO 字符串 / 秒 / 毫秒，三种都兼容 |
| 角色映射 | `user`→user，`assistant`→assistant，**跳过** `system` / `tool` | `human`→user，`assistant`→assistant |
| 多模态 | `parts` 里的图片/语音/附件转为 `[图片]` `[语音]` `[附件]` 占位 | `thinking` 片段归入思考区 |
| 隐藏消息 | 过滤 `metadata.is_visually_hidden_from_conversation` | — |
| 成环保护 | 有（`Set` 记录已访问节点，不死循环） | — |
| `current_node` 缺失 | **1.23.1 修复**：正确走"最长路径回溯"而非按时间排序 | — |

### 安全设计

- **追加式导入**，绝不覆盖或删除现有对话
- 导入前用 `navigator.storage.estimate()` 预估空间，不足会先提示
- 每个会话写入后单独 try/catch `saveLocal()`；一旦命中配额错误（`QuotaExceededError` 等），**立即回滚这次已导入的全部会话**并保持原有数据不变，同时给出明确建议
- 明显重复的会话标 `⚠️ 疑似重复` 且**默认不勾选**（只提示，不自动删）
- 每 20 个会话让出主线程并刷新进度，超大文件（>300MB）会先确认

> 💡 浏览器 localStorage 只有约 5MB。如果要导入大量历史，建议先在「⚙ 设置 → 存储目录」绑定一个文件夹——数据会写到磁盘 `conversations.json`，没有 5MB 限制。

---## 📂 前端目录结构

```
js/
├── state.js              # 全局状态变量
├── utils.js              # 通用工具（含模板变量解析、分支树辅助、端点推断）
├── config.js             # 默认配置、本地持久化、参数三级继承
├── storage.js            # 草稿 + IndexedDB + 文件夹同步
├── session.js            # 会话增删改查、搜索、分支面包屑
├── markdown.js           # Markdown 渲染、思考分离、颜文字替换
├── api.js                # 多平台请求 + RAG 检索 + 临时文件 + 记忆接口 + 工具/多模态消息体
├── main.js               # 应用入口 init() + Skill 组合 + 构建轮询
├── ui/
│   ├── sidebar.js        # 侧栏会话列表（含分支缩进）
│   ├── input.js          # 输入框、快捷模板、语音、拖拽上传、图片压缩
│   ├── settings.js       # 设置面板、预设、模板、颜文字、平台管理、记忆管理
│   └── messages.js       # 消息渲染、RAG 引用卡片、工具调用卡片、图片预览、消息导航
└── features/
    ├── chat.js           # 对话核心（发送 / 重发 / 续写 / 分叉 / 记忆提取 / 工具多轮循环）
    ├── compress.js       # 上下文压缩
    ├── export.js         # 导出 MD/TXT/JSON、备份恢复、工具调用与图片的导出附加内容
    ├── tools.js          # ★ 1.23 工具注册表与本地执行（只读、无副作用）
    ├── stats.js          # ★ 1.23 token 用量聚合、费用估算、统计面板、CSV 导出
    └── importer.js       # ★ 1.23 ChatGPT / Claude 历史解析、预览勾选、配额保护导入
```

加载顺序在 `index.html` 底部，共 18 个 `<script src="js/...">`，无打包、无构建。
新增的 3 个模块（tools / stats / importer）插在 `api.js` 之后、`ui/sidebar.js` 之前加载。

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
  - **1.23.1 起支持带引号的值**（`"all"` / `'all'`）和带 BOM 的文件
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
| `GET`  | `/api/skill_content?skill_id=xxx` | 读取指定 Skill 的 `SKILL.md` + `emoji_config.json` + `rag_scope`（★ 1.23.1 修复：`name` 现在返回 front-matter 里的显示名而不是文件夹 ID） |
| `GET`  | `/api/emoji?skill_id=xxx` | ★ 1.23.1 新增：获取颜文字映射（不传 `skill_id` 时读根目录的 `emoji_config.json`） |
| `GET`  | `/api/config` | 获取当前后端配置 |
| `POST` | `/api/config` | 动态修改配置（热重载 skill_dir + 重启监听） |
| `POST` | `/api/build` | 异步重建向量库（增量，★ 1.23.1 修复并发竞态） |
| `GET`  | `/api/build_status` | 获取构建进度和触发来源 |
| `GET`  | `/api/search?query=xxx&top_k=3&skill_id=xxx&scope=self` | RAG 检索（支持命名空间隔离，★ 1.23.1 修复 `top_k` 越界 500） |
| `POST` | `/api/open_folder` | 在文件管理器中打开并选中文件 |
| `POST` | `/api/embed` | 获取文本向量（用于临时 RAG） |
| `POST` | `/api/parse_temp_file` | 解析上传的临时文件（PDF/Word 走后端，★ 1.23.1 修复临时文件泄漏） |
| `GET`  | `/api/memory/list` | 获取所有长期记忆 |
| `POST` | `/api/memory/add` | 添加一条记忆（★ 1.23.1 修复毫秒 ID 碰撞 + 加锁原子写入） |
| `POST` | `/api/memory/delete` | 删除一条记忆 |
| `GET`  | `/api/memory/search?query=xxx&top_k=3` | 检索记忆（★ 1.23.1 修复脏记录导致 500） |

交互式文档：启动后访问 <http://127.0.0.1:8000/docs>。

> **1.23 的四个新功能不依赖新后端接口**，全部在前端实现：
> - 成本统计：读写浏览器 `localStorage`（`chat_usage` / `chat_usage_log`）
> - 视觉输入：图片在浏览器本地压缩后直接发给所选平台
> - 工具调用：5 个工具全部在浏览器本地执行，其中 `rag_search` 复用上面的 `/api/search`
> - 历史导入：纯前端解析 `conversations.json`，不需要上传到后端
>
> 这样设计是为了不新增任何后端鉴权面——本项目的后端接口是无鉴权的。
>
> **1.23.1 补了一个 `/api/emoji` 路由**（GET），用于修复此前 `resetEmo` 的 404；它同样是只读、无鉴权、只能读 `skill_dir` 内的文件（带路径穿越防护）。

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
| 🖼️ 视觉输入 | 启用/禁用图片输入，调整图片最长边上限（256~4096px） |
| 🔧 工具调用 | 启用/禁用 function calling，调整最大调用轮次（1~20） |
| 系统提示词 | 未加载 Skill 时生效 |
| Temperature / Top P / num_ctx / num_predict | 全局参数（可被预设或会话覆盖） |
| 字体大小 / 主题色 | 界面外观 |
| 提示词模板 | 输入框上方的快捷按钮，支持 `{{date}}` 等变量 |
| 角色预设 | 本地保存的系统提示词预设，可附带参数覆盖（★ 1.23.1 起支持一键"启用"） |

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Ctrl + V` | 粘贴截图（图片直接进输入区） |
| `Ctrl + N` | 新建对话 |
| `Ctrl + K` | 清空输入框 |
| `Ctrl + ,` | 打开设置 |
| `Esc` | 停止生成 / 取消引用 / 取消编辑 / 关闭弹窗与图片预览 |
| 右键「🔧 工具」按钮 | 查看工具清单 |

---

## 📁 目录结构

```
.
├── index.html                 # 前端骨架 + 18 个 <script src>
├── css/                       # 8 个样式表
│   ├── base.css               # 变量、reset、主题
│   ├── layout.css             # 侧栏、顶栏、面包屑
│   ├── chat.css               # 消息、思考框、代码块、RAG 引用卡片
│   ├── input.css              # 输入区、快捷模板、语音、拖拽上传
│   ├── modal.css              # 弹窗、设置、Skill 组合、参数面板
│   ├── stats.css              # ★ 1.23 成本统计面板与趋势图
│   ├── importer.css           # ★ 1.23 历史导入预览界面
│   └── tools.css              # ★ 1.23 工具调用卡片、图片、费用徽章
├── js/                        # 18 个前端模块（含 3 个 1.23 新增）
├── rag_server.py              # 后端 RAG 服务（含 watchdog + 记忆系统）
├── requirements.txt
├── 一键启动狸猫ai工具盒.bat     # 一键启动
├── 启动RAG秘书.bat             # 只启动后端
├── config.example.json        # 配置模板
├── LICENSE
├── README.md
├── docsCHANGELOG.md           # 更新日志
├── tests/                     # ★ 1.23.1 测试套件（241 项断言）
│   ├── 运行测试.bat            # 双击即可跑全部测试
│   ├── run-all.ps1            # 测试编排（5 个套件）
│   ├── static-check.ps1       # 静态检查（语法 / 重复声明 / Python 语法）
│   ├── test_tools.js          # 工具调用模块（86 项）
│   ├── test_importer.js       # 历史导入模块（36 项）
│   ├── test_integration.js    # 集成冒烟（125 项）
│   └── test_backend.py        # ★ 1.23.1 后端回归（116 项，带沙箱）
│
├── .gitignore                 # ★ 重要：以下内容都在里面
├── config.json                # 本地配置（.gitignore）
├── memory.json                # 长期记忆数据（.gitignore）
├── memory.json.bad            # 损坏时的自动备份（.gitignore）
├── memory.json.tmp            # 原子写入的中间文件（.gitignore）
├── file_hashes.json           # 增量更新缓存（.gitignore）
├── chroma_db/                 # 向量库（.gitignore）
├── conversations.json         # 绑定存储目录时生成（.gitignore）
└── __pycache__/               # Python 字节码缓存（.gitignore）
```

> 成本统计的 `chat_usage` / `chat_usage_log` 存在浏览器 localStorage 中，不是文件。

---

## 🧪 测试

1.23.1 附带一套自动化测试（**241 项断言**），改完代码后建议跑一遍，确认没有把旧功能改坏：

```bash
# 方式 A：双击
tests\运行测试.bat

# 方式 B：命令行
powershell -ExecutionPolicy Bypass -File tests\run-all.ps1
```

| 套件 | 覆盖内容 | 断言数 |
|---|---|---|
| 1/5 静态检查 | 18 个模块逐个语法检查、跨文件重复顶层声明、按加载顺序拼接后整体解析、后端 Python 语法 | — |
| 2/5 工具调用 | 工具注册表完整性、schema 不泄漏内部字段、参数 JSON 容错（围栏/截断/噪声）、计算器安全求值（含注入尝试）、工具执行永不抛异常、**OpenAI 分片拼接**、多模态消息体 | 86 |
| 3/5 历史导入 | 格式识别、ChatGPT 对话树回溯、成环不死循环、`current_node` 缺失兜底、隐藏消息过滤、三种时间格式、空会话跳过、标题兜底 | 36 |
| 4/5 集成冒烟 | 按 `index.html` 真实顺序加载全部 18 个模块并跑 `init()`、**1.22 全部旧函数仍在**、1.23 新函数齐备、必需 DOM id 齐全、CSS 引用完整、新功能运行时行为、**1.22 旧 localStorage 配置升级**、旧消息渲染降级、**1.23.1 修复项回归**（`data-last` / `navTicks` 索引 / `compare` 长度 / `tempRagFiles` 清空 / 纯图片发送 / 预设启用链路 / 多轮 token 累加 / 版本栈工具与 usage 还原） | 125 |
| 5/5 后端回归 | **`split_text` 死循环防护**、**watchdog 忽略正则跨平台**、**watchdog 事件类型过滤**、**`/api/skill_content` 返回真正的 name**、**`find_skill_root` 根目录识别**、**`parse_rag_scope` 接受引号与 BOM**、**`/api/emoji` 路由存在**、**`search_memory` 脏记录不 500**、**`top_k` 越界夹取**、**`add_memory` 毫秒 ID 不碰撞 + 原子写入**、**`run_build_task` 异常后状态复位**、**`/api/build` 并发拒绝**、**`read_file_content` 白名单补齐** | 116 |

**测试设计要点**：

- 需要 Node.js（跑前端模块）+ Python（后端回归测试）
- **不需要启动 Ollama 或后端服务**——测试会刻意制造"向量服务不可用"的场景，验证所有降级路径
- `test_backend.py` 用**独立沙箱目录**重定向 `CONF` / `MEMORY_PATH` / `HASH_CACHE_PATH` / `CHROMA_PATH`，**绝不触碰项目里真实的 `config.json` / `memory.json` / `file_hashes.json` / `chroma_db`**——即使测试中途异常退出也不会损坏任何真实数据
- 输出里会有大量 `⚠️ 获取向量失败 / ConnectionError`，这是**故意不启动 Ollama**产生的预期噪音，不是错误

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
6. **1.23.1 修复**：如果日志里出现 `嵌入全部失败，跳过且不记录缓存（下次会重试）`，说明 Ollama 的向量服务不可用——这条文件的 hash 不会被记录，**下次构建会自动重试**，不会像旧版那样静默永久跳过
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
4. 图片和文档会自动分流：图片走多模态输入，文档走临时知识库
</details>

<details>
<summary><b>发了图片但 AI 看不到 / 说没收到图片</b></summary>

1. **最常见原因：模型不支持视觉**。纯文本模型（如 `qwen2.5:7b`）会静默忽略图片。请改用多模态模型：
   - 本地：`ollama pull llama3.2-vision` / `llava` / `qwen2-vl` / `minicpm-v`
   - 云端：`gpt-4o`、`qwen-vl-max`、`glm-4v` 等
2. 确认「⚙ 设置 → 🖼️ 视觉输入」里的开关是**勾选**状态
3. 确认图片确实出现在输入框上方的 chip 区（没有的话看 F12 控制台有没有报错）
4. 图片在本地压缩后发送，如果原图特别小、文字特别密，压缩后可能看不清，可调大「图片最长边上限」
</details>

<details>
<summary><b>临时文件拖进去但 AI 读不到内容</b></summary>

1. 确认文件大小不超过 5MB
2. 文本文件（.md/.txt/.py/.html/.json 等）由前端直接读取，如果编码不是 UTF-8，可能显示乱码
3. 查看浏览器 F12 控制台是否有报错
4. 临时文件内容超过 3000 字会被截断，这是正常的（防止爆 token）
5. 确认拖进去的是文档而不是图片——图片会走多模态通道，需要视觉模型
6. **1.23.1 修复**：临时文件在**发送后即清空**，不会反复注入到后续每一条消息
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
<summary><b>工具调用不生效 / 报错 / 模型输出乱掉了</b></summary>

1. 确认顶栏「🔧 工具」徽章显示「开」（不放心的右键它看工具清单）
2. **Ollama 的部分模型对 tool calling 支持不完善**，可能报 400 或输出异常。这是模型侧限制，不是本项目的 bug
   - 建议换支持工具调用的模型，或把该功能关掉
3. 云端平台一般支持较好（DeepSeek、OpenAI、Qwen 等）
4. 模型一直反复调用工具时会在达到「最大轮次」后停下并给出提示，可在设置里调大或调小
5. 关闭开关后行为与 1.22 完全一致，可放心作为兜底
6. **1.23.1 修复**：工具调用时 AI 回答气泡不再闪烁工具原始返回值；token 用量按**各轮累加**而不是取最后一轮
</details>

<details>
<summary><b>成本统计里费用不准 / 显示"免费"</b></summary>

1. 价格表是**内置的参考值**，会随平台调价而过时。打开 `js/features/stats.js`，修改顶部 `USAGE_PRICE_TABLE` 即可
2. 显示「本地免费」= 判定为本地模型（provider 类型是 ollama，或模型名像本地模型且不在价格表里）
3. 显示「免费」= 云端模型但不在价格表覆盖范围内，成本按 0 计
4. **完全不显示费用徽章** = 该条消息没有拿到真实 token 用量，或模型不在价格表内。这是刻意的设计，避免用估算值伪装成真实费用
5. 若某平台拿不到用量，先确认它是否在流式响应里返回 `usage`（可在 F12 网络面板查看最后一帧）
</details>

<details>
<summary><b>统计面板是空的 / 没有我的对话</b></summary>

1. 统计只记录**开启该功能之后**产生的对话。1.22 及以前的历史消息没有真实用量，不会计入
2. 确认模型确实返回了 token 用量（本地 Ollama 需要较新版本，会返回 `eval_count`）
3. 试试把时间范围切到「全部」
4. 数据存在 `localStorage` 的 `chat_usage` 键，清空浏览器数据会一起丢失
</details>

<details>
<summary><b>导入 ChatGPT 历史后对话是空的 / 少了很多</b></summary>

1. 确认选的是官方导出包里的 **`conversations.json`**（不是 `chat.html` 或其它文件）
2. ChatGPT 的对话是**树形**结构，本项目只还原**当前分支**，被放弃的支线不会导入
3. `system` / `tool` 角色消息与标记为隐藏的消息会被跳过（这是有意为之，否则会污染对话）
4. 预览面板里的「跳过 K 个」会说明原因，请先看一眼
5. 如果提示存储不足：浏览器 localStorage 只有约 5MB。建议先在「⚙ 设置 → 存储目录」绑定文件夹，或分批导入
6. **1.23.1 修复**：`current_node` 字段缺失时（部分导出包会出现），原来会退化成按时间排序、把被放弃的分支也混进来；现在会正确走"最长路径回溯"
</details>

<details>
<summary><b>导入到一半失败 / 我的对话会不会丢？</b></summary>

不会。导入是**追加式**的，且每一步都做了配额检测：

- 一旦发现存储写不下，会**立即回滚本次已导入的会话**，原有对话完全不受影响
- 会弹出明确提示，并给出两个建议：只勾选部分会话分批导入，或先绑定存储目录（写磁盘，无 5MB 限制）
- 你的原有对话**从头到尾不会被改写或删除**
</details>

<details>
<summary><b>Skill 下拉框是空的</b></summary>

- 检查 `skill_dir` 下的文件夹里是否有 `SKILL.md`（文件名**大写**，区分大小写）
- 后端用的是 `os.walk` 递归扫描，多层目录也能找到
- **1.23.1 新增**：如果 `skill_dir` **根目录**本身就有 `SKILL.md`，它也会被识别为一个 Skill（id 为 `.`）
</details>

<details>
<summary><b>颜文字不显示 / 显示成 `[emo:xxx]`</b></summary>

- 检查 Skill 目录里是否有 `emoji_config.json`，且和 `SKILL.md` 同级
- 确认前端已经选择了那个 Skill
- **多 Skill 组合时**，emoji 库是合并的，同名的以后加载的为准
- 设置面板的「颜文字映射」区可以手动添加/修改；顶部的「↻ 从后端重新拉取」按钮走 `/api/emoji`
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

<details>
<summary><b>角色预设怎么启用？（1.23.1 新增功能）</b></summary>

1. 打开「⚙ 设置」→「角色预设」区域
2. 每个预设行右侧有「**启用**」按钮，点一下即可生效
3. 启用后：
   - 顶栏会显示一个绿色的预设徽章（如 `🎭 我的预设`）
   - 点这个徽章可以**快速停用**
   - 该预设的 system prompt 会被注入（未加载 Skill 时生效）
   - 该预设的参数覆盖会被应用（优先级：会话 > 预设 > 全局）
4. 设置会**持久化到 `cfg.activePresetId`**，下次打开页面自动恢复

> 💡 删除或改 ID 后，`init()` 会自动清理无效引用，不会卡住。
</details>

<details>
<summary><b>`memory.json` 突然空了 / 变成了 `.bad` 文件</b></summary>

**1.23.1 新增的自我保护机制**。如果 `memory.json` 因为意外（磁盘满、进程被杀、断电）被写坏：

1. 后端**不会静默当成空数组**（那样下一次写入会永久抹掉旧数据）
2. 会先把损坏的文件**重命名**为 `memory.json.bad` 保留一份
3. 然后按"空记忆"继续运行，让你至少能用

**恢复方法**：

1. 关闭后端
2. 打开 `memory.json.bad`，看看能不能用文本编辑器手工修复（通常是某个字段少了个引号或逗号）
3. 修好后，把它**重命名回 `memory.json`**（先删掉现在的空文件）
4. 重启后端

另外，`memory.json.tmp` 是"原子写入"的中间文件——如果看到它**残留**，说明写入过程被中断过。正常情况下它会在 `os.replace` 后立刻消失。
</details>

<details>
<summary><b>1.22 的配置和数据升级到 1.23 / 1.23.1 会丢吗？</b></summary>

不会。1.23 及 1.23.1 **没有修改任何既有的数据结构**：

- `cfg`（`chat_cfg`）只**新增**字段（`visionEnabled`、`imageMaxEdge`、`toolsEnabled`、`maxToolRounds`、`toolAutoApprove`、`activePresetId`），读取时自动带默认值，旧配置直接可用
- `sessions` / `messages` 的结构没变，只是**可选地**多出 `images` / `toolCalls` / `toolResults` / `promptTokens` / `completionTokens` 字段
- 旧的 AI 消息（没有这些新字段）渲染时会自动回退到原来的估算逻辑，不会报错
- `memory.json` / `chroma_db` / `file_hashes.json` 完全没有改动；**升级后第一次运行不会重写 `memory.json`**
- 备份文件格式仍是 `{version, savedAt, cfg, sessions, presets, drafts}`，**双向兼容**：1.23.1 的备份能被 1.22 恢复（新字段会被忽略），1.22 的备份也能被 1.23.1 恢复
</details>

<details>
<summary><b>新功能会不会影响原有功能？</b></summary>

不会，且这是本次开发的首要约束：

- **工具调用默认关闭**，关闭时 `runStreamWithTools` 的行为与 1.22 的单轮 `runStream` 完全等价
- **视觉输入默认开启但不改变文本路径**：没有图片时消息体与 1.22 一模一样
- **成本统计与历史导入是纯增量功能**，不介入现有的发送、渲染、导出流程
- 导出/备份的逻辑只在**有**工具调用或图片时才追加额外内容，普通对话导出结果不变
- 1.23 / 1.23.1 额外**修复**了若干 1.22 的既有缺陷（见更新日志），没有降低任何旧行为
</details>

---

## 🔒 安全声明

- 本项目**仅监听 `127.0.0.1`**，默认不对外暴露。
- 后端接口**无鉴权**，请勿将 `host` 改为 `0.0.0.0` 后部署到公网。
- API Key 明文存储在 `localStorage` 中，请勿在公共电脑上保存敏感密钥。
- 如确有远程使用需求，请自行加 HTTPS + Token 鉴权 + 反向代理。
- 后端所有涉及文件的接口（`/api/skill_content`、`/api/emoji`、`/api/open_folder`）都带**路径穿越防护**，只能访问 `skill_dir` 内的文件。

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
- [x] 视觉模型输入 / 拖拽图片（1.23）
- [x] 工具调用 / function calling（1.23）
- [x] 导入 ChatGPT / Claude 历史（1.23）
- [x] 成本统计（1.23）
- [x] **1.23.1 稳定性补丁**（详见顶部"1.23.1 稳定性补丁"小节）

### 未来计划

- [ ] MCP 协议接入
- [ ] 数据加密
- [ ] 插件市场

### 1.23 已知问题（**均已在 1.23.1 修复**）

- ~~**角色预设实际未生效**：`currentPresetId` 全项目没有任何赋值点~~ → **1.23.1 已修**，新增 `setActivePreset` / `restoreActivePreset` / 顶栏徽章
- ~~**`resetEmo` 调用了一个后端不存在的接口**~~ → **1.23.1 已修**，后端补了 `/api/emoji` 路由

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