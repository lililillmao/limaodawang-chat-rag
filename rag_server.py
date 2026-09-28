import os
import glob
import json
import re
import hashlib
import requests
import chromadb
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
import docx
from pydantic import BaseModel

# ================= 配置加载 =================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
HASH_CACHE_PATH = os.path.join(SCRIPT_DIR, "file_hashes.json")

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

# 构建进度全局状态
BUILD_STATUS = {
    "status": "idle",       # idle / running / completed / failed
    "message": "就绪",
    "progress": 0,
    "total": 0,
    "current_file": ""
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

# 初始化 ChromaDB
CHROMA_PATH = os.path.join(SCRIPT_DIR, "chroma_db")
client = chromadb.PersistentClient(path=CHROMA_PATH)
try:
    collection = client.get_collection(name="skill_knowledge")
except Exception:
    collection = client.create_collection(name="skill_knowledge")

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
    return {"status": "success", "skill_dir": new_dir}

# ================= 知识库构建接口 =================
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
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks

def read_file_content(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext == '.pdf':
            reader = PdfReader(filepath)
            return "\n".join([page.extract_text() for page in reader.pages if page.extract_text()])
        elif ext == '.docx':
            doc = docx.Document(filepath)
            return "\n".join([para.text for para in doc.paragraphs])
        elif ext in ['.md', '.txt', '.py', '.json', '.csv', '.html', '.css', '.js']:
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

def run_build_task():
    global BUILD_STATUS
    BUILD_STATUS["status"] = "running"
    BUILD_STATUS["message"] = "正在扫描文件..."
    BUILD_STATUS["progress"] = 0
    BUILD_STATUS["total"] = 0
    BUILD_STATUS["current_file"] = ""

    if not os.path.exists(BASE_SKILL_DIR):
        BUILD_STATUS["status"] = "failed"
        BUILD_STATUS["message"] = f"Skill 目录不存在: {BASE_SKILL_DIR}"
        return

    # 读取历史哈希
    old_hashes = {}
    if os.path.exists(HASH_CACHE_PATH):
        try:
            with open(HASH_CACHE_PATH, 'r', encoding='utf-8') as f:
                old_hashes = json.load(f)
        except Exception as e:
            print(f"⚠️ 读取 hash 缓存失败: {e}")

    files = glob.glob(os.path.join(BASE_SKILL_DIR, "**", "*"), recursive=True)
    valid_files = [f for f in files if os.path.isfile(f)]
    BUILD_STATUS["total"] = len(valid_files)

    new_hashes = {}
    processed_count = 0
    total_chunks = 0

    for filepath in valid_files:
        processed_count += 1
        file_name = os.path.basename(filepath)
        BUILD_STATUS["current_file"] = file_name
        BUILD_STATUS["message"] = f"正在处理: {file_name} ({processed_count}/{BUILD_STATUS['total']})"
        
        # 计算 MD5
        current_md5 = get_file_md5(filepath)
        if not current_md5:
            BUILD_STATUS["progress"] = processed_count
            continue

        new_hashes[filepath] = current_md5

        # 增量判断
        if filepath in old_hashes and old_hashes[filepath] == current_md5:
            # 文件未修改，跳过
            BUILD_STATUS["progress"] = processed_count
            continue

        print(f"🔄 检测到文件变化，重建中: {file_name}")
        
        # 删除旧数据
        try:
            old_data = collection.get(where={"source": filepath})
            if old_data and old_data["ids"]:
                collection.delete(ids=old_data["ids"])
                print(f"  🗑️ 已删除 {len(old_data['ids'])} 个旧片段")
        except Exception as e:
            print(f"  ⚠️ 删除旧数据失败: {e}")

        # 读取新内容
        content = read_file_content(filepath)
        if not content or len(content.strip()) < 10:
            BUILD_STATUS["progress"] = processed_count
            continue

        chunks = split_text(content)
        for i, chunk in enumerate(chunks):
            emb = get_embedding(chunk)
            if emb:
                chunk_id = f"{filepath}_md5_{current_md5}_{i}"
                collection.add(
                    documents=[chunk],
                    embeddings=[emb],
                    metadatas=[{"source": filepath, "chunk": i}],
                    ids=[chunk_id]
                )
                total_chunks += 1

        BUILD_STATUS["progress"] = processed_count

    # 清理已被删除的文件对应的哈希记录
    final_hashes = {}
    for k, v in new_hashes.items():
        final_hashes[k] = v
    try:
        with open(HASH_CACHE_PATH, 'w', encoding='utf-8') as f:
            json.dump(final_hashes, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ 写入 hash 缓存失败: {e}")

    BUILD_STATUS["status"] = "completed"
    BUILD_STATUS["message"] = f"构建完成！新增/更新 {total_chunks} 个片段"
    print(f"✅ {BUILD_STATUS['message']}")

@app.post("/api/build")
async def build_knowledge_base(background_tasks: BackgroundTasks):
    global BUILD_STATUS
    if BUILD_STATUS["status"] == "running":
        return {"status": "running", "message": "已有构建任务在运行中"}
    
    background_tasks.add_task(run_build_task)
    return {"status": "started", "message": "构建任务已在后台启动，请通过 /api/build_status 查询进度"}

@app.get("/api/build_status")
def get_build_status():
    return BUILD_STATUS

# ================= 其他接口 =================
def is_path_inside(base, target):
    if not base: return False
    base_abs = os.path.realpath(base)
    target_abs = os.path.realpath(target)
    return target_abs == base_abs or target_abs.startswith(base_abs + os.sep)

@app.get("/")
def read_root():
    return {"status": "RAG 秘书已启动", "folder": BASE_SKILL_DIR, "config": CONFIG_PATH}

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
                name = folder_name
                match = re.search(r'name:\s*(.*)', content)
                if match: name = match.group(1).strip()
                skills_list.append({"id": skill_id, "name": name, "path": root})
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
        with open(skill_path, "r", encoding="utf-8") as f: content = f.read()
    except Exception as e: return {"content": "", "error": str(e)}
    emoji = {}
    emoji_path = os.path.join(skill_dir, "emoji_config.json")
    if os.path.exists(emoji_path):
        try:
            with open(emoji_path, "r", encoding="utf-8") as f: emoji = json.load(f)
        except Exception as e: print(f"⚠️ 读取 {emoji_path} 失败: {e}")
    return {"content": content, "name": skill_id, "emoji": emoji}

@app.get("/api/search")
def search(query: str, top_k: int = 3):
    if not query: return {"results": [], "safety_flag": False}
    if SAFETY_KEYWORDS and any(kw in query for kw in SAFETY_KEYWORDS):
        safety_text = ""
        if SAFETY_FALLBACK_PATH and os.path.exists(SAFETY_FALLBACK_PATH):
            try:
                with open(SAFETY_FALLBACK_PATH, "r", encoding="utf-8") as f: safety_text = f.read()
            except Exception as e: print(f"⚠️ 读取安全兜底文件失败: {e}")
        if not safety_text:
            safety_text = ("你刚说的这个，我有点担心。现在有人能陪着你吗？如果情况紧急，打 110 或 120。心理援助热线 12356。")
        print(f"🚨 触发安全拦截：{query}")
        return {"results": [{"content": safety_text, "source": "safety_override", "distance": 0.0}], "safety_flag": True}
    emb = get_embedding(query)
    if not emb: return {"results": [], "safety_flag": False, "error": "向量服务不可用"}
    try:
        results = collection.query(query_embeddings=[emb], n_results=top_k)
        output = []
        if results.get('documents') and len(results['documents']) > 0:
            for i in range(len(results['documents'][0])):
                output.append({
                    "content": results['documents'][0][i],
                    "source": results['metadatas'][0][i]['source'],
                    "distance": results['distances'][0][i] if 'distances' in results else 0
                })
        return {"results": output, "safety_flag": False}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    print("🚀 RAG 秘书启动中...")
    print(f"📂 配置文件: {CONFIG_PATH}")
    print(f"📂 Skill 目录: {BASE_SKILL_DIR}")
    print(f"📂 向量模型: {EMBED_MODEL} @ {OLLAMA_URL}")
    if not os.path.exists(BASE_SKILL_DIR):
        print(f"⚠️ 警告：Skill 目录不存在！请修改 config.json 里的 skill_dir")
    uvicorn.run(app, host=CONF["host"], port=int(CONF["port"]))