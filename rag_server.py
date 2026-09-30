import os
import glob
import json
import re
import sys
import time
import hashlib
import threading
import subprocess
import requests
import chromadb
import math
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
import docx
from pydantic import BaseModel

# watchdog（可选依赖，缺失时降级为手动模式）
try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    WATCHDOG_AVAILABLE = True
except ImportError:
    WATCHDOG_AVAILABLE = False
    print("⚠️ 未安装 watchdog，文件自动监听不可用")
    print("⚠️ 如需开启请运行：pip install watchdog")

# ================= 配置加载 =================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
HASH_CACHE_PATH = os.path.join(SCRIPT_DIR, "file_hashes.json")
MEMORY_PATH = os.path.join(SCRIPT_DIR, "memory.json")
HASH_CACHE_VERSION = 3

DEFAULT_CONFIG = {
    "skill_dir": "./skills",
    "ollama_url": "http://127.0.0.1:11434",
    "embed_model": "nomic-embed-text",
    "chunk_size": 600,
    "chunk_overlap": 100,
    "host": "127.0.0.1",
    "port": 8000,
    "safety_keywords": [
        "自杀", "自残", "想死", "不想活了", "割腕",
        "家暴", "打死我", "他打我", "想跳楼"
    ],
    "safety_fallback_path": ""
}

BUILD_STATUS = {
    "status": "idle",
    "message": "就绪",
    "progress": 0,
    "total": 0,
    "current_file": "",
    "trigger": "",
}

def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        return dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user_cfg = json.load(f)
    except Exception as e:
        print(f"⚠️ 读取 config.json 失败: {e}，将使用默认配置")
        return dict(DEFAULT_CONFIG)
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(user_cfg)
    return cfg

CONF = load_config()

def resolve_path(p):
    if not p:
        return ""
    if os.path.isabs(p):
        return p
    return os.path.normpath(os.path.join(SCRIPT_DIR, p))

BASE_SKILL_DIR = resolve_path(CONF["skill_dir"])
EMBED_MODEL = CONF["embed_model"]
CHUNK_SIZE = int(CONF["chunk_size"])
CHUNK_OVERLAP = int(CONF["chunk_overlap"])
OLLAMA_URL = CONF["ollama_url"].rstrip("/")
SAFETY_KEYWORDS = CONF.get("safety_keywords", []) or []
SAFETY_FALLBACK_PATH = resolve_path(CONF.get("safety_fallback_path", ""))

# ================= ChromaDB =================
CHROMA_PATH = os.path.join(SCRIPT_DIR, "chroma_db")
client = chromadb.PersistentClient(path=CHROMA_PATH)
COLLECTION_NAME = "skill_knowledge"
MEMORY_COLLECTION_NAME = "user_memory"

# ★ 修复：init_collection 加了 space 校验
def init_collection(name, metadata=None):
    try:
        col = client.get_collection(name=name)
        meta = getattr(col, "metadata", None) or {}
        space = meta.get("hnsw:space", "")
        if space != "cosine":
            print("⚠️" * 20)
            print(f"⚠️ 集合 {name} 使用的是 '{space or 'L2（默认）'}' 距离，不是 cosine。")
            print("⚠️ 相关度百分比会显示异常。")
            print("⚠️ 请关闭本窗口，删除项目根目录下的 chroma_db 文件夹，再重启。")
            print("⚠️" * 20)
        return col
    except Exception:
        print(f"ℹ️ 新建向量库: {name}")
        return client.create_collection(
            name=name,
            metadata=metadata or {"hnsw:space": "cosine"}
        )

collection = init_collection(COLLECTION_NAME, {"hnsw:space": "cosine"})
memory_collection = init_collection(MEMORY_COLLECTION_NAME, {"hnsw:space": "cosine"})

app = FastAPI(title="RAG 知识库秘书")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ================= 配置接口 =================
class ConfigUpdate(BaseModel):
    skill_dir: str

class OpenFolderReq(BaseModel):
    path: str

class EmbedReq(BaseModel):
    text: str

class MemoryAddReq(BaseModel):
    content: str
    source: str = "手动添加"

@app.get("/api/config")
def get_config():
    return {"skill_dir": CONF.get("skill_dir", "./skills")}

@app.post("/api/config")
def update_config(update: ConfigUpdate):
    global CONF, BASE_SKILL_DIR
    new_dir = update.skill_dir.strip()
    if not new_dir:
        raise HTTPException(status_code=400, detail="目录不能为空")
    CONF["skill_dir"] = new_dir
    BASE_SKILL_DIR = resolve_path(new_dir)
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(CONF, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ 写入 config.json 失败: {e}")
    print(f"🔄 Skill 目录已动态更新为: {BASE_SKILL_DIR}")
    restart_watcher()
    return {"status": "success", "skill_dir": new_dir}

# ================= 工具函数 =================
def get_embedding(text):
    try:
        r = requests.post(f"{OLLAMA_URL}/api/embeddings", json={
            "model": EMBED_MODEL,
            "prompt": text
        }, timeout=30)
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception as e:
        print(f"⚠️ 获取向量失败: {e}")
        return None

def split_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    # ★ 修复：overlap >= chunk_size 时 start += chunk_size - overlap 不前进（等于 0 或负数），
    #   会导致 while 死循环并把内存撑爆。config.json 里的 chunk_size / chunk_overlap
    #   是用户可直接编辑的，所以必须在这里做防御，而不是信任配置。
    try:
        chunk_size = int(chunk_size)
    except (TypeError, ValueError):
        chunk_size = 600
    try:
        overlap = int(overlap)
    except (TypeError, ValueError):
        overlap = 100
    if chunk_size < 1:
        print(f"⚠️ chunk_size={chunk_size} 非法，已回退为 600")
        chunk_size = 600
    if overlap < 0:
        overlap = 0
    if overlap >= chunk_size:
        # 步长必须至少为 1，否则永远前进不了
        safe_overlap = chunk_size - 1
        print(f"⚠️ chunk_overlap({overlap}) >= chunk_size({chunk_size})，已自动调整为 {safe_overlap}")
        overlap = safe_overlap

    step = chunk_size - overlap  # 此时恒 >= 1
    chunks = []
    start = 0
    n = len(text)
    while start < n:
        end = start + chunk_size
        chunks.append(text[start:end])
        start += step
    return chunks

# 可直读的纯文本扩展名。
# ★ 修复【14】：原白名单只有 8 个扩展名，.yaml/.yml/.xml/.sh/.toml/.log/.ini 与
#   无扩展名的 LICENSE / README 全部返回 None，但这些文件的 hash 仍会被记入缓存，
#   于是"永久不索引"却被当成"已处理、未变化"，构建日志显示一切正常。
#   前端 input.js 是把 xml/yaml/yml 当可读文本处理的，这里补齐以保持一致。
TEXT_EXTS = {
    '.md', '.markdown', '.txt', '.text', '.py', '.json', '.csv', '.tsv',
    '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.xml', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf', '.log', '.sh', '.bash', '.bat', '.ps1',
    '.sql', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb',
    '.php', '.swift', '.kt', '.lua', '.r', '.m', '.pl', '.env', '.gitignore',
}
# 无扩展名但通常是纯文本的文件（按文件名精确匹配）
TEXT_BASENAMES = {
    'license', 'licence', 'readme', 'changelog', 'notice', 'authors',
    'contributing', 'makefile', 'dockerfile', 'procfile', 'gemfile',
}

def looks_like_text(filepath, max_bytes=512 * 1024):
    """对未知扩展名做一次保守探测：体积不大且能按 UTF-8 解码、且不含 NUL 字节。

    ★ 修复【14】：用"内容探测"兜底，避免因为扩展名白名单太窄而静默漏索引
      （例如 LICENSE、README、无扩展名的配置）。二进制文件会被 NUL 字节或
      UnicodeDecodeError 挡掉。
    """
    try:
        if os.path.getsize(filepath) > max_bytes:
            return False
        with open(filepath, 'rb') as f:
            head = f.read(8192)
        if not head:
            return False
        if b'\x00' in head:
            return False
        head.decode('utf-8')
        return True
    except Exception:
        return False

def read_file_content(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    base = os.path.basename(filepath).lower()
    try:
        if ext == '.pdf':
            reader = PdfReader(filepath)
            return "\n".join([page.extract_text() for page in reader.pages if page.extract_text()])
        elif ext == '.docx':
            doc = docx.Document(filepath)
            return "\n".join([para.text for para in doc.paragraphs])
        elif ext in TEXT_EXTS or base in TEXT_BASENAMES:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        elif looks_like_text(filepath):
            # ★ 修复【14】：未知扩展名但看起来是纯文本 → 也索引，避免静默漏掉
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        else:
            return None
    except Exception as e:
        print(f"⚠️ 读取 {filepath} 失败: {e}")
        return None

def get_file_md5(filepath):
    try:
        with open(filepath, 'rb') as f:
            return hashlib.md5(f.read()).hexdigest()
    except Exception as e:
        print(f"⚠️ 计算 MD5 失败 {filepath}: {e}")
        return None

def parse_skill_name(content, fallback):
    """从 SKILL.md 里解析展示用名字。
    ★ 修复：原实现用 re.search(r'name:\\s*(.*)', content) 在【全文】里找第一个 name:，
      既可能匹配到 front-matter 之外的正文，也可能匹配到 `  name:` 这类子字段，
      还会把 Windows 换行残留的 \\r 带进结果。这里优先只看 front-matter，
      并且只在行首（允许缩进）匹配 name:。
    """
    if content:
        # 1) 优先只解析 front-matter 区块
        fm = re.match(r'^\s*---\s*\n(.*?)\n\s*---', content, re.DOTALL)
        scope_text = fm.group(1) if fm else content
        m = re.search(r'^[ \t]*name[ \t]*:[ \t]*(.+)$', scope_text, re.MULTILINE)
        if m:
            name = m.group(1).strip().strip('"').strip("'").strip()
            if name:
                return name
            # front-matter 里有 name: 但值为空时，退回文件夹名
    return fallback

def get_cached_md5(entry):
    """读取 hash 缓存条目里的 md5。
    ★ 兼容两种格式：
      · 旧格式：直接是 md5 字符串
      · 新格式：{"md5": ..., "skill_id": ...}
    这样升级到 1.23 后不会因为 schema 变化而强制全量重嵌。
    """
    if isinstance(entry, dict):
        return entry.get("md5")
    if isinstance(entry, str):
        return entry
    return None

def get_cached_skill(entry):
    """读取缓存条目里记录的 skill_id；旧格式没有这个信息，返回 None 表示"未知"。"""
    if isinstance(entry, dict):
        return entry.get("skill_id")
    return None

def find_skill_root(filepath, base_dir):
    if not base_dir:
        return ""
    base_real = os.path.realpath(base_dir)
    cur = os.path.dirname(os.path.realpath(filepath))
    # ★ 修复：原实现一上来就 `if cur == base_real: return ""`，
    #   于是放在 skill_dir 根目录的文件永远归属不到根级 SKILL.md，
    #   而 list_skills 给根级 SKILL.md 的 id 是 "."。
    #   结果：根目录文档的 skill_id 为空，scope=self 检索时永远搜不到它。
    root_has_skill = os.path.exists(os.path.join(base_real, "SKILL.md"))
    while True:
        if cur == base_real:
            return "." if root_has_skill else ""
        if not cur.startswith(base_real):
            return ""
        if os.path.exists(os.path.join(cur, "SKILL.md")):
            return os.path.relpath(cur, base_real)
        parent = os.path.dirname(cur)
        if parent == cur:
            return ""
        cur = parent

def parse_front_matter(content):
    """解析 SKILL.md 的 front-matter，返回其文本；没有则返回 ""。
    ★ 修复【10】：原 parse_rag_scope 用 `^---`，遇到带 UTF-8 BOM 的文件就匹配不上，
      于是静默退化成 self；这里统一先去掉 BOM 再匹配，并与 parse_skill_name 用同一标准。
    """
    if not content:
        return ""
    text = content.lstrip("\ufeff")
    fm = re.match(r'^\s*---\s*\n(.*?)\n\s*---', text, re.DOTALL)
    return fm.group(1) if fm else ""

def parse_rag_scope(skill_md_path):
    try:
        with open(skill_md_path, "r", encoding="utf-8") as f:
            content = f.read()
        body = parse_front_matter(content)
        if body:
            # ★ 修复【10】：原正则 `rag_scope:\s*(\w+)` 不接受带引号的值。
            #   `rag_scope: "all"` 会因为 \w+ 匹配不到引号而静默退化成 self，
            #   用户写的"全库检索"被悄悄收窄成"仅本 Skill"，且没有任何提示。
            m = re.search(r'^[ \t]*rag_scope[ \t]*:[ \t]*(.+)$', body, re.MULTILINE)
            if m:
                scope = m.group(1).strip().strip('"').strip("'").strip().lower()
                if scope in ("self", "all"):
                    return scope
                print(f"⚠️ {skill_md_path} 的 rag_scope 取值无法识别：{scope!r}，已按 self 处理（只接受 self / all）")
    except Exception:
        pass
    return "self"

# ================= 记忆系统接口 =================
# ★ 修复【8】：memory.json 原来是"读-改-写"且完全无锁、非原子保存。
#   两个请求交错（两个标签页同时添加、或"自动提取"与"手动添加"撞在一起）会互相覆盖；
#   写盘中途进程被 kill / 磁盘满会把文件截断成非法 JSON，
#   而 load_memories 的 `except: return []` 又把它静默当成空数组，
#   于是下一次 add_memory 就会以 [] 为基础 append 并整文件覆写 —— 之前的记忆全部丢失，
#   没有任何报错、也没有备份。
#   这里加：模块级锁 + tmp 原子替换 + 损坏文件先备份后降级。
MEMORY_LOCK = threading.Lock()

def load_memories():
    if not os.path.exists(MEMORY_PATH):
        return []
    try:
        with open(MEMORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("memory.json 不是数组格式")
        return data
    except Exception as e:
        # 不要把"文件损坏"静默降级成"没有记忆"——那样下一次写入会永久抹掉旧数据。
        # 先留一份 .bad 备份，方便用户手工抢救。
        try:
            bad_path = MEMORY_PATH + ".bad"
            if not os.path.exists(bad_path):
                os.replace(MEMORY_PATH, bad_path)
                print(f"⚠️ memory.json 解析失败（{e}），已备份为 {bad_path}，本次按空记忆继续。")
            else:
                print(f"⚠️ memory.json 解析失败（{e}），已存在备份 {bad_path}，本次按空记忆继续。")
        except Exception as e2:
            print(f"⚠️ memory.json 解析失败（{e}）且备份失败：{e2}")
        return []

def save_memories(memories):
    # ★ 原子写入：先写 .tmp 再 os.replace，避免写一半崩溃留下截断文件
    tmp_path = MEMORY_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(memories, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, MEMORY_PATH)

def _mutate_memories(fn):
    """在锁内完成 读 → 改 → 写，返回 fn(memories) 的返回值。

    约定（两种用法都支持，且必须都安全）：
      · fn 就地修改传入的列表（例如 append）→ 返回 None 或任意标量，
        此时落盘的是就地修改后的原列表；
      · fn 返回一个【列表】（例如过滤）→ 用它替换列表内容。

    ★ 这里刻意只在 fn 返回 list 时才替换：如果无条件用返回值替换，
      那么像 `lambda ms: ms.append(x)` 这类返回 None 的写法会把列表清空，
      而返回标量（例如 len(ms)、append 的返回值）的写法会把整个文件写成一个数字，
      直接把 memory.json 写坏（表现为下次 load 解析失败 → 全部记忆丢失）。
    """
    with MEMORY_LOCK:
        memories = load_memories()
        result = fn(memories)
        if isinstance(result, list):
            memories = result
        save_memories(memories)
        return result

@app.get("/api/memory/list")
def list_memories():
    memories = load_memories()
    return {"memories": memories}

# ★ 修复：把 id 也写进 metadata，让检索时能按 id 过滤
@app.post("/api/memory/add")
def add_memory(req: MemoryAddReq):
    # ★ 修复【8】：整段"读-改-写"放进锁里，避免并发请求互相覆盖。
    #   注意 chromadb 的 add 对重复 id 是【忽略】而非 upsert（审计实测），
    #   所以 id 唯一性必须在这里保证。
    def _do(memories):
        existing_ids = {m.get("id") for m in memories if isinstance(m, dict)}
        base = int(time.time() * 1000)
        memory_id = "m" + str(base)
        suffix = 0
        while memory_id in existing_ids:
            suffix += 1
            memory_id = "m" + str(base) + "_" + str(suffix)
        now_ms = int(time.time() * 1000)
        memories.append({
            "id": memory_id,
            "content": req.content,
            "source": req.source,
            "time": now_ms,
            "enabled": True
        })
        return memory_id

    try:
        memory_id = _mutate_memories(_do)
    except Exception as e:
        print(f"⚠️ 写入 memory.json 失败: {e}")
        return {"status": "error", "error": str(e)}

    # 向量写入放在文件写成功之后：宁可"有记忆但没向量"（可搜索性差），
    # 也不要"有向量但 json 没写"（产生永远删不掉的孤儿向量）。
    emb = get_embedding(req.content)
    if emb:
        try:
            memory_collection.add(
                documents=[req.content],
                embeddings=[emb],
                metadatas=[{"id": memory_id, "source": req.source, "time": int(time.time() * 1000)}],
                ids=[memory_id]
            )
        except Exception as e:
            print(f"⚠️ 记忆向量写入失败：{e}")
    else:
        # 向量失败时 memory.json 仍会写入，但向量库里没有这条，
        # 表现为"记忆列表里有、检索永远搜不到"。这里显式打出来，避免静默不一致。
        print(f"⚠️ 记忆 '{req.content[:20]}' 的向量生成失败，已只写入 memory.json（该条暂时无法被检索）")
    return {"status": "success", "id": memory_id}

@app.post("/api/memory/delete")
def delete_memory(req: MemoryAddReq):
    # ★ 修复：原来用 m["id"] 硬索引，memory.json 里若存在缺 id 的脏记录会直接 KeyError → 500
    # ★ 修复【8】：改成锁内读-改-写
    def _do(memories):
        return [m for m in memories if not (isinstance(m, dict) and m.get("id") == req.content)]

    try:
        _mutate_memories(_do)
    except Exception as e:
        print(f"⚠️ 删除记忆失败: {e}")
        return {"status": "error", "error": str(e)}
    try:
        memory_collection.delete(ids=[req.content])
    except Exception:
        pass
    return {"status": "success"}

# ★ 修复：过滤掉 enabled=false 的记忆
@app.get("/api/memory/search")
def search_memory(query: str, top_k: int = 3):
    if not query:
        return {"results": []}

    all_memories = load_memories()
    # ★ 修复：原来这里用 m["id"] 硬索引，且整段在 try 之外——
    #   memory.json 里只要有一条缺 id 的脏记录（手工编辑、旧版本写入、写盘中途损坏
    #   都会产生），/api/memory/search 就会 KeyError → 500，
    #   于是"记忆功能整体失效"，连正常记忆也搜不出来，且用户看不到任何错误。
    #   这里与 delete_memory 的修复保持同一风格：只认 dict、用 .get()、剔除 None。
    enabled_ids = {
        m.get("id") for m in all_memories
        if isinstance(m, dict) and m.get("enabled", True) and m.get("id")
    }
    if not enabled_ids:
        return {"results": []}

    emb = get_embedding(query)
    if not emb:
        return {"results": []}
    try:
        # ★ 修复：top_k 未做约束。chromadb 对 n_results<=0 会抛
        #   TypeError: Number of requested results 0, cannot be negative, or zero.
        #   前端一旦传了 0/负数（或将来做参数化）就是 500。这里夹到 [1, 50]。
        safe_k = max(1, min(int(top_k), 50))
        results = memory_collection.query(
            query_embeddings=[emb],
            n_results=safe_k,
            where={"id": {"$in": list(enabled_ids)}}
        )
        output = []
        if results.get('documents') and len(results['documents']) > 0:
            metas = results.get('metadatas') or [[]]
            dists = results.get('distances') or [[]]
            for i in range(len(results['documents'][0])):
                meta = (metas[0][i] if i < len(metas[0]) else None) or {}
                output.append({
                    "content": results['documents'][0][i],
                    "source": meta.get('source', ''),
                    "distance": dists[0][i] if (dists and i < len(dists[0])) else 0
                })
        return {"results": output}
    except Exception as e:
        print(f"⚠️ 记忆检索失败: {e}")
        return {"results": [], "error": str(e)}

# ================= 知识库构建 =================
def run_build_task(trigger="manual"):
    global BUILD_STATUS
    BUILD_STATUS["status"] = "running"
    BUILD_STATUS["message"] = "正在扫描文件..."
    BUILD_STATUS["progress"] = 0
    BUILD_STATUS["total"] = 0
    BUILD_STATUS["current_file"] = ""
    BUILD_STATUS["trigger"] = trigger
    BUILD_STATUS.pop("last_error", None)

    # ★ 修复【13】：把 skill_dir 快照到局部变量。
    #   原来整个长事务里反复读取全局 BASE_SKILL_DIR，如果构建期间用户在设置面板
    #   改了目录，valid_files 来自旧目录、find_skill_root 却用新目录 →
    #   cur.startswith(base_real) 为假 → 这批文件的 skill_id 被写成 ""，
    #   于是 scope=self 永远搜不到它们，而且 hash 已记录、无法自愈。
    base_dir = BASE_SKILL_DIR

    try:
        _run_build_inner(trigger, base_dir)
    except Exception as e:
        # ★ 修复【3】：原函数没有 try/finally，任何未捕获异常（最典型的是改 embed_model
        #   导致 collection.add 抛向量维度错误）都会让 BUILD_STATUS 永久卡在 "running"，
        #   于是 /api/build 永远返回"已有构建任务在运行中"，前端按钮永久禁用、轮询不结束，
        #   只能重启服务；而真正的异常只出现在控制台。
        import traceback
        err_text = f"{type(e).__name__}: {e}"
        BUILD_STATUS["status"] = "failed"
        BUILD_STATUS["message"] = f"构建失败：{err_text}"
        BUILD_STATUS["last_error"] = err_text
        print(f"❌ [{trigger}] 构建异常：{err_text}")
        traceback.print_exc()
    finally:
        # 兜底：无论走哪条路径，都不允许状态停留在 "running"
        if BUILD_STATUS.get("status") == "running":
            BUILD_STATUS["status"] = "failed"
            BUILD_STATUS["message"] = "构建异常终止（未捕获的错误），状态已被重置。请查看后端控制台。"
            print(f"❌ [{trigger}] 构建异常终止，状态已重置为 failed")

def _run_build_inner(trigger, base_dir):
    global BUILD_STATUS
    if not os.path.exists(base_dir):
        BUILD_STATUS["status"] = "failed"
        BUILD_STATUS["message"] = f"Skill 目录不存在: {base_dir}"
        return

    try:
        current_count = collection.count()
    except Exception:
        current_count = 0
    force_full = (current_count == 0)

    old_hashes = {}
    if os.path.exists(HASH_CACHE_PATH) and not force_full:
        try:
            with open(HASH_CACHE_PATH, 'r', encoding='utf-8') as f:
                cached = json.load(f)
            if cached.get("__version__") != HASH_CACHE_VERSION:
                print(f"⚠️ 哈希缓存 schema 版本不匹配（旧={cached.get('__version__')}，新={HASH_CACHE_VERSION}），将全量重建")
                old_hashes = {}
            else:
                old_hashes = {k: v for k, v in cached.items() if k != "__version__"}
        except Exception as e:
            print(f"⚠️ 读取 hash 缓存失败: {e}")
    elif force_full:
        print(f"ℹ️ 向量库为空（count=0），将全量重建")

    # ★ 修复【7】：用 glob.escape 处理 skill_dir 里的 glob 元字符。
    #   原来 os.path.join(BASE_SKILL_DIR, "**", "*") 在目录名含 [ ] 等字符时
    #   （例如 E:/skills[1]）会被当成字符类，glob 结果为空 → valid_files 为空 →
    #   下面的孤儿清理会把整个向量库删光，并把 file_hashes.json 覆写成空。
    files = glob.glob(os.path.join(glob.escape(base_dir), "**", "*"), recursive=True)
    valid_files = [f for f in files if os.path.isfile(f)]
    BUILD_STATUS["total"] = len(valid_files)

    new_hashes = {}
    processed_count = 0
    total_chunks = 0
    skipped_count = 0
    failed_files = []
    folder_has_skill = os.path.exists(os.path.join(base_dir, "SKILL.md"))

    for filepath in valid_files:
        processed_count += 1
        file_name = os.path.basename(filepath)
        BUILD_STATUS["current_file"] = file_name
        BUILD_STATUS["message"] = f"正在处理: {file_name} ({processed_count}/{BUILD_STATUS['total']})"

        current_md5 = get_file_md5(filepath)
        if not current_md5:
            BUILD_STATUS["progress"] = processed_count
            continue

        # ★ 修复【1】：跳过判断不能只看 md5，还要看该文件的 skill_id 是否变了。
        #   给已索引目录补写 SKILL.md、删改某层 SKILL.md、或把 skill_dir 指向子目录时，
        #   文件字节没变但归属 skill 变了；只看 md5 会让向量保留旧 skill_id，
        #   于是 scope=self 检索永远 0 条，而 hash 已记新值 → 永远跳过 → 无法自愈。
        skill_id = find_skill_root(filepath, base_dir)

        if not force_full and filepath in old_hashes and get_cached_md5(old_hashes[filepath]) == current_md5:
            old_skill = get_cached_skill(old_hashes[filepath])
            if old_skill is None or old_skill == skill_id:
                new_hashes[filepath] = {"md5": current_md5, "skill_id": skill_id}
                BUILD_STATUS["progress"] = processed_count
                skipped_count += 1
                continue
            print(f"🔄 skill 归属变化（{old_skill!r} → {skill_id!r}），重嵌: {file_name}")

        print(f"🔄 检测到文件变化，重建中: {file_name}")

        content = read_file_content(filepath)
        if not content or len(content.strip()) < 10:
            # ★ 修复【2】：内容为空/类型不支持/解析失败时，不要把 hash 记进缓存。
            #   原实现先写 new_hashes 再读内容，于是"记录成功但零向量"永久固化，
            #   构建日志还显示"跳过 N 个未变化文件"，看起来一切正常。
            if content is not None:
                # 读到了内容但太短：属于"合理跳过"，记进缓存避免每次重试
                new_hashes[filepath] = {"md5": current_md5, "skill_id": skill_id}
            else:
                failed_files.append(file_name)
                print(f"  ⚠️ 跳过（不支持的类型或解析失败）: {file_name}")
            BUILD_STATUS["progress"] = processed_count
            continue

        chunks = split_text(content)
        # ★ 修复【2】：先把本文件的全部向量准备好，成功后再删旧、再写入。
        #   原实现"先删旧向量 → 再逐块嵌入"，只要嵌入失败（Ollama 未启动 / 维度不符 /
        #   超时），旧向量已经删掉、新向量没写，hash 却记下了 → 该文件在库里彻底消失
        #   且后续每轮都跳过，即使把文件恢复成完全相同的字节也无法自愈。
        embeddings = []
        embed_failed = False
        for chunk in chunks:
            emb = get_embedding(chunk)
            if emb:
                embeddings.append(emb)
            else:
                embed_failed = True
        if embed_failed and not embeddings:
            failed_files.append(file_name)
            BUILD_STATUS["progress"] = processed_count
            print(f"  ⚠️ 嵌入全部失败，跳过且不记录缓存（下次会重试）: {file_name}")
            continue

        try:
            old_data = collection.get(where={"source": filepath})
            if old_data and old_data["ids"]:
                collection.delete(ids=old_data["ids"])
                print(f"  🗑️ 已删除 {len(old_data['ids'])} 个旧片段")
        except Exception as e:
            print(f"  ⚠️ 删除旧数据失败: {e}")

        for i, chunk in enumerate(chunks):
            if i >= len(embeddings):
                break
            chunk_id = f"{filepath}_md5_{current_md5}_{i}"
            try:
                collection.add(
                    documents=[chunk],
                    embeddings=[embeddings[i]],
                    metadatas=[{
                        "source": filepath,
                        "chunk": i,
                        "skill_id": skill_id,
                    }],
                    ids=[chunk_id]
                )
                total_chunks += 1
            except Exception as e:
                print(f"  ⚠️ 写入片段失败 ({file_name} #{i}): {e}")
                embed_failed = True

        # 只有真正写成功才记缓存
        if not embed_failed:
            new_hashes[filepath] = {"md5": current_md5, "skill_id": skill_id}
        else:
            failed_files.append(file_name)
        BUILD_STATUS["progress"] = processed_count

    # ★ 修复：孤儿清理必须带安全阀。
    #   原实现无条件把"不在本轮 new_hashes 里的 source"全删掉。一旦本轮扫描异常为空
    #   （skill_dir 配错、目录被清空、glob 元字符、磁盘未挂载），就会一次删光整个向量库。
    try:
        existing_sources = set(new_hashes.keys())
        scanned = len(valid_files)
        # 安全阀：本轮扫描为 0 个文件，但库里仍有向量 → 拒绝清理
        if scanned == 0 and current_count > 0:
            print(f"⚠️ 本轮扫描到 0 个文件，但向量库有 {current_count} 个片段 —— 跳过孤儿清理以免误删。"
                  f"请检查 skill_dir 是否配置正确：{base_dir}")
            BUILD_STATUS["warn"] = "扫描到 0 个文件，已跳过清理以免误删向量库"
        else:
            all_meta = collection.get(include=["metadatas"])
            if all_meta and all_meta.get("metadatas"):
                to_delete = []
                for i, meta in enumerate(all_meta["metadatas"]):
                    src = (meta or {}).get("source", "")
                    if src and src not in existing_sources:
                        to_delete.append(all_meta["ids"][i])
                if to_delete:
                    # 再设一道阈值闸：单次清理超过现有向量的 90% 也要警告（很可能是配置事故）
                    if current_count > 0 and len(to_delete) >= current_count * 0.9 and len(existing_sources) < current_count * 0.1:
                        print(f"⚠️ 本轮将清理 {len(to_delete)}/{current_count} 个片段（超过 90%），"
                              f"疑似 skill_dir 配置错误 —— 已跳过清理。请检查：{base_dir}")
                        BUILD_STATUS["warn"] = "本次清理量异常（>90%），已跳过以免误删"
                    else:
                        collection.delete(ids=to_delete)
                        print(f"🗑️ 清理已删除文件的向量：{len(to_delete)} 个片段")
    except Exception as e:
        print(f"⚠️ 清理已删除文件失败: {e}")

    final_hashes = {"__version__": HASH_CACHE_VERSION}
    final_hashes.update(new_hashes)
    try:
        # ★ 修复：改为 tmp + 原子替换，避免写盘中途崩溃把缓存截断成非法 JSON
        tmp_path = HASH_CACHE_PATH + ".tmp"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(final_hashes, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, HASH_CACHE_PATH)
    except Exception as e:
        print(f"⚠️ 写入 hash 缓存失败: {e}")

    BUILD_STATUS["status"] = "completed"
    if total_chunks == 0 and skipped_count > 0:
        BUILD_STATUS["message"] = f"无需更新（{skipped_count} 个文件均无变化）"
    else:
        BUILD_STATUS["message"] = f"构建完成！新增/更新 {total_chunks} 个片段（跳过 {skipped_count} 个未变化文件）"
    if failed_files:
        BUILD_STATUS["message"] += f"；{len(failed_files)} 个文件失败或类型不支持，未记入缓存（下次会重试）"
        BUILD_STATUS["failed_files"] = failed_files[:20]
    print(f"✅ [{trigger}] {BUILD_STATUS['message']}")

@app.post("/api/build")
async def build_knowledge_base(background_tasks: BackgroundTasks):
    global BUILD_STATUS
    # ★ 修复【4】【18】：
    #   原实现是"先判断 status != running → 再 add_task"，而 run_build_task 要等
    #   BackgroundTasks 在响应发出之后才真正开始执行、到那时才把状态置为 running。
    #   于是存在一个窗口：两个 POST /api/build 都会通过检查，各自排一个后台任务，
    #   两个线程同时全量扫描同一个库（重复嵌入、状态互相覆盖）。
    #   同时因为状态还没变，前端第一次轮询 build_status 读到的仍是上一轮的 "completed"，
    #   会提前显示"🎉 构建完成"并重新启用按钮。
    #   这里在锁内把"判断 + 置 running"做成原子操作，并同步清掉上一轮的 message。
    with _watch_lock:
        if BUILD_STATUS["status"] == "running":
            return {"status": "running", "message": "已有构建任务在运行中"}
        BUILD_STATUS["status"] = "running"
        BUILD_STATUS["message"] = "构建任务已排队，正在启动..."
        BUILD_STATUS["progress"] = 0
        BUILD_STATUS["total"] = 0
        BUILD_STATUS["current_file"] = ""
        BUILD_STATUS["trigger"] = "manual"
    background_tasks.add_task(run_build_task, "manual")
    return {"status": "started", "message": "构建任务已在后台启动"}

@app.get("/api/build_status")
def get_build_status():
    return BUILD_STATUS

# ================= 文件监听 =================
_watch_lock = threading.Lock()
_pending_rebuild = False
_rebuild_scheduled = False
_watch_observer = None

def _schedule_rebuild(reason=""):
    global _pending_rebuild, _rebuild_scheduled
    # ★ 修复【4】：锁只保护了 _pending_rebuild 的读写，但 "检查 running → 启动线程"
    #   这个 check-then-act 仍然不在临界区里，两个事件同时到达就会各起一个构建线程。
    #   再加上一个"已排程"标志，保证同一时刻最多只有一个待跑的构建线程。
    with _watch_lock:
        if BUILD_STATUS["status"] == "running":
            _pending_rebuild = True
            print(f"⏳ 检测到文件变化（{reason}），但正在构建，稍后自动重试")
            return
        if _rebuild_scheduled:
            _pending_rebuild = True
            return
        _rebuild_scheduled = True
    t = threading.Thread(target=_run_and_check_pending, args=(reason,), daemon=True)
    t.start()

def _run_and_check_pending(reason=""):
    global _pending_rebuild, _rebuild_scheduled
    again = False
    try:
        run_build_task(trigger=f"watchdog:{reason}" if reason else "watchdog")
    finally:
        # ★ 修复：run_build_task 内部虽然已包了 try/except，这里再兜一层，
        #   保证 _rebuild_scheduled 在任何情况下都被释放，否则后续文件变化永远不会再触发构建。
        with _watch_lock:
            _rebuild_scheduled = False
            again = _pending_rebuild
            _pending_rebuild = False
    if again:
        print("🔄 检测到构建期间又有文件变化，重新扫描")
        time.sleep(0.5)
        _run_and_check_pending(reason)

if WATCHDOG_AVAILABLE:
    class SkillDirHandler(FileSystemEventHandler):
        def __init__(self):
            self._timer = None
            self._lock = threading.Lock()
            # ★ 修复：原正则把路径分隔符硬编码成 Windows 的反斜杠，
            #   在 Linux / macOS 上 \\chroma_db\\ 永远匹配不到，导致 chroma_db 自身
            #   的写入会不断触发重建（自我触发循环）。这里改成 [\\/] 兼容两种分隔符。
            self._ignore = re.compile(
                r'(~$|\.tmp$|\.swp$|\.swx$|\.bak$|\.crdownload$|\.part$|'
                r'[\\/]chroma_db[\\/]|[\\/]__pycache__[\\/]|\.DS_Store$|Thumbs\.db$|'
                r'file_hashes\.json$|conversations\.json$|memory\.json$)',
                re.IGNORECASE
            )

        def _should_ignore(self, path):
            return bool(self._ignore.search(path))

        def _trigger(self, path):
            base = os.path.basename(path)
            _schedule_rebuild(base)

        def on_any_event(self, event):
            if event.is_directory:
                return
            # ★ 修复【6】：必须过滤事件类型。
            #   watchdog 在 Linux(inotify) 上的掩码包含 IN_OPEN / IN_CLOSE_NOWRITE，
            #   会派发出 FileOpenedEvent / FileClosedEvent；而 run_build_task、
            #   /api/skills、/api/skill_content 都会"读文件"。
            #   只挡路径的话就会形成：构建读文件 → 产生 opened 事件 → 防抖触发重建 →
            #   再读文件 → …… 一个永不停止的自我维持重建循环。
            #   Windows 默认不上报 open/close，但把 last-access 打开后同样会命中。
            #   这里只接受"内容/结构真正变化"的事件类型。
            etype = getattr(event, "event_type", None)
            if etype is not None and etype not in ("created", "modified", "moved", "deleted"):
                return
            # 构建进行中时，进一步忽略纯读事件，避免自触发
            if etype in ("opened", "closed"):
                return
            path = event.src_path
            if self._should_ignore(path):
                return
            with self._lock:
                if self._timer:
                    self._timer.cancel()
                self._timer = threading.Timer(2.0, self._trigger, args=(path,))
                self._timer.daemon = True
                self._timer.start()

def start_watcher():
    global _watch_observer, _rebuild_scheduled
    if not WATCHDOG_AVAILABLE:
        return
    if not os.path.exists(BASE_SKILL_DIR):
        print(f"⚠️ Skill 目录不存在，无法启动文件监听: {BASE_SKILL_DIR}")
        return
    # ★ 重启监听时重置排程标志，避免上一次构建异常残留导致再也不触发自动更新
    with _watch_lock:
        _rebuild_scheduled = False
    stop_watcher()
    try:
        handler = SkillDirHandler()
        observer = Observer()
        observer.schedule(handler, BASE_SKILL_DIR, recursive=True)
        observer.daemon = True
        observer.start()
        _watch_observer = observer
        print(f"👀 已启动文件监听：{BASE_SKILL_DIR}")
        print(f"   （修改文件后约 2 秒会自动增量更新，无需手动点“重建知识库”）")
    except Exception as e:
        print(f"⚠️ 启动文件监听失败: {e}")

def stop_watcher():
    global _watch_observer
    if _watch_observer:
        try:
            _watch_observer.stop()
            _watch_observer.join(timeout=3)
        except Exception:
            pass
        _watch_observer = None

def restart_watcher():
    stop_watcher()
    start_watcher()

# ================= 其他接口 =================
def is_path_inside(base, target):
    if not base: return False
    base_abs = os.path.realpath(base)
    target_abs = os.path.realpath(target)
    return target_abs == base_abs or target_abs.startswith(base_abs + os.sep)

@app.get("/")
def read_root():
    return {
        "status": "RAG 秘书已启动",
        "folder": BASE_SKILL_DIR,
        "config": CONFIG_PATH,
        "watchdog": WATCHDOG_AVAILABLE,
        "watching": _watch_observer is not None,
    }

@app.get("/api/skills")
def list_skills():
    skills_list = []
    if not os.path.exists(BASE_SKILL_DIR):
        return {"skills": [], "error": f"Skill 目录不存在: {BASE_SKILL_DIR}"}
    for root, dirs, files in os.walk(BASE_SKILL_DIR):
        if "SKILL.md" in files:
            skill_md_path = os.path.join(root, "SKILL.md")
            skill_id = os.path.relpath(root, BASE_SKILL_DIR)
            folder_name = os.path.basename(root)
            try:
                with open(skill_md_path, "r", encoding="utf-8") as f:
                    content = f.read()
                # ★ 修复：改用 parse_skill_name，避免在正文里误匹配 name: 并带上 \r
                name = parse_skill_name(content, folder_name)
                scope = parse_rag_scope(skill_md_path)
                skills_list.append({"id": skill_id, "name": name, "path": root, "rag_scope": scope})
            except Exception as e:
                print(f"⚠️ 读取 {skill_md_path} 失败: {e}")
    return {"skills": skills_list}

@app.get("/api/skill_content")
def get_skill_content(skill_id: str):
    if not skill_id: return {"content": "", "error": "skill_id 为空"}
    skill_dir = os.path.join(BASE_SKILL_DIR, skill_id)
    skill_path = os.path.join(skill_dir, "SKILL.md")
    if not is_path_inside(BASE_SKILL_DIR, skill_path): return {"content": "", "error": "非法路径"}
    if not os.path.exists(skill_path): return {"content": "", "error": "SKILL.md 未找到"}
    try:
        with open(skill_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"content": "", "error": str(e)}

    rag_scope = parse_rag_scope(skill_path)

    emoji = {}
    emoji_path = os.path.join(skill_dir, "emoji_config.json")
    if os.path.exists(emoji_path):
        try:
            with open(emoji_path, "r", encoding="utf-8") as f:
                emoji = json.load(f)
        except Exception as e:
            print(f"⚠️ 读取 {emoji_path} 失败: {e}")

    # ★ 修复：原实现 name 直接回显 skill_id（也就是文件夹相对路径），
    #   而 /api/skills 已经解析过 front-matter 的 name。
    #   结果：刷新页面后前端 fetchSkillMeta 用这个 name 覆盖掉列表里的好名字，
    #   Skill 徽章显示成文件夹名（例如 "狸猫测试官" 而不是 "狸猫"）。
    #   这里与 /api/skills 保持一致，用 parse_skill_name 解析真正的展示名。
    fallback_name = os.path.basename(skill_dir) or skill_id
    return {
        "content": content,
        "name": parse_skill_name(content, fallback_name),
        "emoji": emoji,
        "rag_scope": rag_scope,
    }

@app.get("/api/emoji")
def get_emoji(skill_id: str = ""):
    """返回颜文字映射表。
    ★ 修复（14）：前端 resetEmo() 一直在请求 /api/emoji，但后端从来没有这个路由，
      所以那个按钮只会 404。这里补上：
        - 指定 skill_id 时读该 Skill 目录下的 emoji_config.json
        - 不指定时读 skill_dir 根目录的 emoji_config.json
      同时这个接口也让前端可以"只取颜文字"，不必为了拿 emoji 而拉整个 SKILL.md 正文。
    """
    if skill_id:
        skill_dir = os.path.join(BASE_SKILL_DIR, skill_id)
        emoji_path = os.path.join(skill_dir, "emoji_config.json")
        if not is_path_inside(BASE_SKILL_DIR, emoji_path):
            return {"emoji": {}, "error": "非法路径"}
    else:
        emoji_path = os.path.join(BASE_SKILL_DIR, "emoji_config.json")

    if not os.path.exists(emoji_path):
        return {"emoji": {}, "error": "emoji_config.json 不存在", "path": emoji_path}
    try:
        with open(emoji_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"emoji": {}, "error": "emoji_config.json 不是对象格式"}
        # 只保留字符串值，避免前端替换出乱码
        emoji = {str(k): str(v) for k, v in data.items() if isinstance(v, (str, int, float))}
        return {"emoji": emoji, "path": emoji_path}
    except Exception as e:
        print(f"⚠️ 读取 {emoji_path} 失败: {e}")
        return {"emoji": {}, "error": str(e)}

@app.get("/api/search")
def search(query: str, top_k: int = 3, skill_id: str = "", scope: str = "self"):
    if not query:
        return {"results": [], "safety_flag": False}

    if SAFETY_KEYWORDS and any(kw in query for kw in SAFETY_KEYWORDS):
        safety_text = ""
        if SAFETY_FALLBACK_PATH and os.path.exists(SAFETY_FALLBACK_PATH):
            try:
                with open(SAFETY_FALLBACK_PATH, "r", encoding="utf-8") as f:
                    safety_text = f.read()
            except Exception as e:
                print(f"⚠️ 读取安全兜底文件失败: {e}")
        if not safety_text:
            safety_text = ("你刚说的这个，我有点担心。现在有人能陪着你吗？如果情况紧急，打 110 或 120。心理援助热线 12356。")
        print(f"🚨 触发安全拦截：{query}")
        return {"results": [{"content": safety_text, "source": "safety_override", "distance": 0.0}], "safety_flag": True}

    emb = get_embedding(query)
    if not emb:
        return {"results": [], "safety_flag": False, "error": "向量服务不可用"}

    where = None
    if scope == "self" and skill_id:
        where = {"skill_id": skill_id}

    try:
        # ★ 修复【12】：top_k 未做约束。chromadb 对 n_results<=0 会抛
        #   TypeError: Number of requested results 0, cannot be negative, or zero.
        #   前端一旦传 0/负数就是 500，而前端只 console.error —— 表现为"RAG 莫名搜不到"。
        safe_k = max(1, min(int(top_k), 50))
        results = collection.query(
            query_embeddings=[emb],
            n_results=safe_k,
            where=where
        )
        output = []
        if results.get('documents') and len(results['documents']) > 0:
            metas = results.get('metadatas') or [[]]
            dists = results.get('distances') or [[]]
            for i in range(len(results['documents'][0])):
                meta = (metas[0][i] if i < len(metas[0]) else None) or {}
                output.append({
                    "content": results['documents'][0][i],
                    # ★ 修复【12】：原来对 'source' 用硬索引，任一向量 metadata 缺该键
                    #   就会 KeyError 让整个 scope=all 检索 500（同一行的 skill_id 却用了 .get()）。
                    "source": meta.get('source', ''),
                    "skill_id": meta.get('skill_id', ''),
                    "distance": dists[0][i] if (dists and i < len(dists[0])) else 0
                })
        return {"results": output, "safety_flag": False}
    except Exception as e:
        # 与 /api/memory/search 的错误风格保持一致：返回结构化的空结果 + error，
        # 而不是让前端只看到 500（前端对非 2xx 只会 console.error，用户完全无感）。
        print(f"⚠️ RAG 检索失败: {e}")
        return {"results": [], "safety_flag": False, "error": str(e)}

@app.post("/api/open_folder")
def open_folder(req: OpenFolderReq):
    file_path = os.path.normpath(req.path.strip())
    if not file_path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    if not is_path_inside(BASE_SKILL_DIR, file_path):
        raise HTTPException(status_code=403, detail="路径不在知识库目录内")
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select," + file_path])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", file_path])
        else:
            folder = os.path.dirname(file_path)
            subprocess.Popen(["xdg-open", folder])
        return {"status": "success", "message": "已在文件管理器中打开"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ================= 临时 RAG 接口 =================
@app.post("/api/embed")
def api_embed(req: EmbedReq):
    emb = get_embedding(req.text)
    if emb is None:
        raise HTTPException(status_code=500, detail="向量服务不可用")
    return {"embedding": emb}

@app.post("/api/parse_temp_file")
async def parse_temp_file(file: UploadFile = File(...)):
    import tempfile
    tmp_path = None
    try:
        # ★ 修复【9】：filename 缺失时 os.path.splitext(None) 抛 TypeError → 500（应为 400）
        if not file.filename:
            raise HTTPException(status_code=400, detail="缺少文件名")
        ext = os.path.splitext(file.filename)[1].lower()
        # ★ 修复【9】：原实现无大小上限，await file.read() 会把整个上传读进内存再落盘，
        #   超大文件可以直接把内存吃满。这里限制 50MB（前端自身限制 5MB，留足余量）。
        MAX_UPLOAD = 50 * 1024 * 1024
        content = await file.read()
        if len(content) > MAX_UPLOAD:
            raise HTTPException(status_code=413, detail=f"文件过大（{len(content) // 1024 // 1024}MB），上限 50MB")
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        text = read_file_content(tmp_path)
        # 注意：这里不能提前 unlink，read_file_content 已读完全部内容到内存，
        # 所以放到 finally 里统一清理是安全的。
        if not text or not text.strip():
            print(f"⚠️ 临时文件 {file.filename} 内容为空")
            return {"filename": file.filename, "chunks": [], "error": "文件内容为空"}

        chunks = split_text(text)
        result = []
        for i, chunk in enumerate(chunks):
            result.append({"text": chunk, "embedding": []})

        print(f"✅ 已解析临时文件 {file.filename}，共 {len(result)} 个片段")
        return {"filename": file.filename, "chunks": result}
    except HTTPException:
        raise
    except Exception as e:
        print(f"⚠️ 解析临时文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # ★ 修复【9】：原实现只在成功路径上 unlink 一次（第 1051 行），
        #   tmp.write 抛异常（磁盘满/权限）或 read_file_content 之后任何异常，
        #   delete=False 建出来的临时文件就永久留在 %TEMP% 里，越积越多。
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

# ================= 启动 =================
@app.on_event("startup")
def on_startup():
    start_watcher()
    def initial_scan():
        time.sleep(2.0)
        print("🔍 启动时扫描知识库...")
        _schedule_rebuild("startup")
    threading.Thread(target=initial_scan, daemon=True).start()

@app.on_event("shutdown")
def on_shutdown():
    stop_watcher()

if __name__ == "__main__":
    import uvicorn
    print("🚀 RAG 秘书启动中...")
    print(f"📂 配置文件: {CONFIG_PATH}")
    print(f"📂 Skill 目录: {BASE_SKILL_DIR}")
    print(f"📂 向量模型: {EMBED_MODEL} @ {OLLAMA_URL}")
    try:
        print(f"📂 知识库现有: {collection.count()} 个片段")
        print(f"📂 记忆库现有: {memory_collection.count()} 条记忆")
    except Exception:
        print(f"📂 知识库/记忆库现有: 0 个片段")
    if not os.path.exists(BASE_SKILL_DIR):
        print(f"⚠️ 警告：Skill 目录不存在！请修改 config.json 里的 skill_dir")
    print(f"👀 文件监听: {'已启用' if WATCHDOG_AVAILABLE else '未安装 watchdog（pip install watchdog）'}")
    uvicorn.run(app, host=CONF["host"], port=int(CONF["port"]))