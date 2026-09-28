import os
import glob
import json
import re
import hashlib
import requests
import chromadb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
import docx


# ================= 配置加载 =================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

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


def load_config():
    """加载配置文件；若不存在则生成一份默认配置"""
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        print(f"📝 已生成默认配置文件: {CONFIG_PATH}")
        print(f"   请根据需要修改 skill_dir 等字段，然后重启本服务。")
        return dict(DEFAULT_CONFIG)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user_cfg = json.load(f)
    except Exception as e:
        print(f"⚠️ 读取 config.json 失败: {e}，将使用默认配置")
        return dict(DEFAULT_CONFIG)

    # 用默认值补齐缺失的键
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(user_cfg)
    return cfg


CONF = load_config()


def resolve_path(p):
    """把相对路径转成相对脚本目录的绝对路径；绝对路径原样返回"""
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
# ==========================================


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


def make_chunk_id(filepath, index):
    """生成稳定的、不会冲突的 chunk ID（含相对路径 + 短哈希）"""
    try:
        rel = os.path.relpath(filepath, BASE_SKILL_DIR)
    except Exception:
        rel = os.path.basename(filepath)
    h = hashlib.md5(filepath.encode("utf-8")).hexdigest()[:8]
    return f"{rel}_{h}_{index}"


def is_path_inside(base, target):
    """判断 target 是否在 base 目录之内（防路径穿越）"""
    if not base:
        return False
    base_abs = os.path.realpath(base)
    target_abs = os.path.realpath(target)
    return target_abs == base_abs or target_abs.startswith(base_abs + os.sep)


@app.get("/")
def read_root():
    return {
        "status": "RAG 秘书已启动",
        "folder": BASE_SKILL_DIR,
        "config": CONFIG_PATH
    }


@app.get("/api/skills")
def list_skills():
    """自动扫描 BASE_SKILL_DIR 下的所有 SKILL.md，返回列表给前端"""
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
                if match:
                    name = match.group(1).strip()

                skills_list.append({
                    "id": skill_id,      # 传给前端的 ID 用相对路径
                    "name": name,
                    "path": root
                })
            except Exception as e:
                print(f"⚠️ 读取 {skill_md_path} 失败: {e}")

    return {"skills": skills_list}


@app.get("/api/skill_content")
def get_skill_content(skill_id: str):
    """根据 skill_id 读取该 Skill 的 SKILL.md 全文。
       如果同级目录下有 emoji_config.json，也一并返回给前端。
    """
    if not skill_id:
        return {"content": "", "error": "skill_id 为空"}

    skill_dir = os.path.join(BASE_SKILL_DIR, skill_id)
    skill_path = os.path.join(skill_dir, "SKILL.md")

    # 防路径穿越
    if not is_path_inside(BASE_SKILL_DIR, skill_path):
        return {"content": "", "error": "非法路径"}

    if not os.path.exists(skill_path):
        return {"content": "", "error": "SKILL.md 未找到，检查路径: " + skill_path}

    try:
        with open(skill_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"content": "", "error": str(e)}

    # 顺便读取同级目录下的 emoji_config.json（可选）
    emoji = {}
    emoji_path = os.path.join(skill_dir, "emoji_config.json")
    if os.path.exists(emoji_path):
        try:
            with open(emoji_path, "r", encoding="utf-8") as f:
                emoji = json.load(f)
            print(f"✅ Skill [{skill_id}] 附带颜文字 {len(emoji)} 个")
        except Exception as e:
            print(f"⚠️ 读取 {emoji_path} 失败: {e}")

    return {"content": content, "name": skill_id, "emoji": emoji}


@app.post("/api/build")
def build_knowledge_base():
    if not os.path.exists(BASE_SKILL_DIR):
        raise HTTPException(
            status_code=400,
            detail=f"Skill 目录不存在: {BASE_SKILL_DIR}（请检查 config.json）"
        )

    global collection
    try:
        client.delete_collection(name="skill_knowledge")
    except Exception as e:
        print(f"ℹ️ 删除旧 collection 时（可忽略）: {e}")
    collection = client.create_collection(name="skill_knowledge")

    files = glob.glob(os.path.join(BASE_SKILL_DIR, "**", "*"), recursive=True)
    total_chunks = 0
    failed_chunks = 0
    file_count = 0

    for filepath in files:
        if not os.path.isfile(filepath):
            continue
        content = read_file_content(filepath)
        if not content or len(content.strip()) < 10:
            continue

        file_count += 1
        chunks = split_text(content)

        for i, chunk in enumerate(chunks):
            emb = get_embedding(chunk)
            if emb:
                collection.add(
                    documents=[chunk],
                    embeddings=[emb],
                    metadatas=[{"source": filepath, "chunk": i}],
                    ids=[make_chunk_id(filepath, i)]
                )
                total_chunks += 1
            else:
                failed_chunks += 1
        print(f"✅ 已处理: {os.path.basename(filepath)} ({len(chunks)} 块)")

    if failed_chunks:
        print(f"⚠️ 有 {failed_chunks} 个 chunk 因向量失败被跳过，请检查 Ollama 是否正常")

    return {
        "status": "构建完成",
        "files_read": file_count,
        "chunks_saved": total_chunks,
        "chunks_failed": failed_chunks
    }


@app.get("/api/search")
def search(query: str, top_k: int = 3):
    if not query:
        return {"results": [], "safety_flag": False}

    # --- 安全危机硬拦截（关键词列表可在 config.json 里修改） ---
    if SAFETY_KEYWORDS and any(kw in query for kw in SAFETY_KEYWORDS):
        safety_text = ""
        if SAFETY_FALLBACK_PATH and os.path.exists(SAFETY_FALLBACK_PATH):
            try:
                with open(SAFETY_FALLBACK_PATH, "r", encoding="utf-8") as f:
                    safety_text = f.read()
            except Exception as e:
                print(f"⚠️ 读取安全兜底文件失败: {e}")
        if not safety_text:
            safety_text = ("你刚说的这个，我有点担心。现在有人能陪着你吗？"
                           "如果情况紧急，打 110 或 120。心理援助热线 12356，随时可以打。")

        print(f"🚨 触发安全拦截：{query}")
        return {
            "results": [{"content": safety_text, "source": "safety_override", "distance": 0.0}],
            "safety_flag": True
        }
    # --- 安全拦截结束 ---

    emb = get_embedding(query)
    if not emb:
        return {"results": [], "safety_flag": False, "error": "向量服务不可用"}

    try:
        results = collection.query(
            query_embeddings=[emb],
            n_results=top_k
        )

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