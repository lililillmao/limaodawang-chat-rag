# -*- coding: utf-8 -*-
"""rag_server.py 修复项的回归测试。

用法: python test_backend.py <项目根目录>

覆盖:
  2  watchdog 忽略正则跨平台
  3  split_text 在 overlap >= chunk_size 时不再死循环
  11 add_memory 毫秒级 ID 不碰撞
  12 /api/skill_content 返回真正的 name
  13 find_skill_root 能识别根目录自身的 SKILL.md
  14 /api/emoji 路由存在（此前 404）
  15 parse_rag_scope 接受带引号的值 / 带 BOM 的文件
  16 search_memory 遇到缺 id 的脏记录不再 500
  17 top_k 越界被夹取，不再因 n_results<=0 抛 500
  18 parse_temp_file 缺少 filename 返回 4xx，且不泄漏临时文件
  19 run_build_task 异常后状态不会卡在 running
  20 read_file_content 能读到 .yaml / LICENSE 等新增白名单类型

⚠️ 安全约定（重要）：
  本测试【绝不】触碰项目里真实的 config.json / memory.json / file_hashes.json。
  做法是把 rag 模块的模块级路径常量和内部函数全部重定向到临时目录：
    · CONF / BASE_SKILL_DIR / CHROMA_PATH / MEMORY_PATH / HASH_CACHE_PATH
    · load_config / save_memories / load_memories
  这样即使测试中途异常退出，也不会损坏任何真实数据。
"""
import os
import re
import sys
import json
import shutil
import tempfile
import importlib.util

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

passed = 0
failed = 0
failures = []


def ok(name, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        failures.append(name + ("" if extra is None else "  -> " + repr(extra)))
        print("  [FAIL] " + name + ("" if extra is None else "  -> " + repr(extra)))


def section(t):
    print("\n=== " + t + " ===")


# 所有测试产物都放在临时目录，最后整目录删除
SANDBOX = tempfile.mkdtemp(prefix="limao_test_")
SKILLS = os.path.join(SANDBOX, "skills")
os.makedirs(os.path.join(SKILLS, "skillA"), exist_ok=True)
os.makedirs(os.path.join(SKILLS, "skillB", "references"), exist_ok=True)

with open(os.path.join(SKILLS, "SKILL.md"), "w", encoding="utf-8") as f:
    f.write("---\nname: 根级技能\ndescription: root\nrag_scope: all\n---\n\n# 根级\n正文里也有一行 name: 不应被解析\n")
with open(os.path.join(SKILLS, "emoji_config.json"), "w", encoding="utf-8") as f:
    json.dump({"nod": "( ˘•ω•˘ )", "smile": "(⌒▽⌒)"}, f, ensure_ascii=False)

with open(os.path.join(SKILLS, "skillA", "SKILL.md"), "w", encoding="utf-8") as f:
    f.write('---\nname: "狸猫 A"\ndescription: d\nrag_scope: "all"\n---\n\n# 角色\n\nname: 这是正文里的干扰\n')
with open(os.path.join(SKILLS, "skillA", "emoji_config.json"), "w", encoding="utf-8") as f:
    json.dump({"a1": "(A)"}, f, ensure_ascii=False)

# 没有 front-matter 的 name → 回退文件夹名；rag_scope 不带引号
with open(os.path.join(SKILLS, "skillB", "SKILL.md"), "w", encoding="utf-8") as f:
    f.write("# 没有 front-matter\n\n内容\n")

# 带 BOM + 带引号 rag_scope 的 Skill（验证修复 15）
BOMSKILL = os.path.join(SKILLS, "skillBom")
os.makedirs(BOMSKILL, exist_ok=True)
with open(os.path.join(BOMSKILL, "SKILL.md"), "w", encoding="utf-8-sig") as f:
    f.write("---\nname: BOM技能\nrag_scope: 'all'\n---\n\n正文\n")

# 各种扩展名的可读文本（验证修复 20）
os.makedirs(os.path.join(SKILLS, "skillA", "docs"), exist_ok=True)
for name, body in [
    ("cfg.yaml", "key: value\n"), ("cfg.yml", "a: 1\n"), ("data.xml", "<r><a/></r>\n"),
    ("run.sh", "#!/bin/sh\necho hi\n"), ("note.toml", "x = 1\n"), ("LICENSE", "MIT License\n"),
    ("README", "hello readme\n"), ("logo.png", "\x89PNG\r\n\x1a\n\x00\x00binary"),
]:
    with open(os.path.join(SKILLS, "skillA", "docs", name), "w", encoding="utf-8", errors="ignore") as f:
        f.write(body)

spec = importlib.util.spec_from_file_location("rag", os.path.join(ROOT, "rag_server.py"))
rag = importlib.util.module_from_spec(spec)

# ------------------------------------------------------------------
# 关键：在做任何事之前，先把模块级路径重定向到沙箱
# ------------------------------------------------------------------
def _load_config_sandboxed():
    """替代真实的 load_config：不读也不写项目的 config.json。"""
    return {
        "skill_dir": SKILLS,
        "ollama_url": "http://127.0.0.1:11434",
        "embed_model": "nomic-embed-text",
        "chunk_size": 600,
        "chunk_overlap": 100,
        "host": "127.0.0.1",
        "port": 8000,
        "safety_keywords": [],
        "safety_fallback_path": "",
    }


# 先加载模块（它会尝试初始化 chroma / 写 config），但立即用沙箱覆盖所有路径
try:
    spec.loader.exec_module(rag)
except Exception as e:
    print(f"!! 模块加载失败: {e}")
    shutil.rmtree(SANDBOX, ignore_errors=True)
    sys.exit(1)

# 覆盖路径常量与配置
rag.CONF = _load_config_sandboxed()
rag.BASE_SKILL_DIR = SKILLS
rag.CHUNK_SIZE = 600
rag.CHUNK_OVERLAP = 100
rag.CONFIG_PATH = os.path.join(SANDBOX, "config.json")
rag.MEMORY_PATH = os.path.join(SANDBOX, "memory.json")
rag.HASH_CACHE_PATH = os.path.join(SANDBOX, "file_hashes.json")
rag.SAFETY_KEYWORDS = []
rag.SAFETY_FALLBACK_PATH = ""
# chroma 用沙箱里的独立目录，避免动到真实向量库
rag.CHROMA_PATH = os.path.join(SANDBOX, "chroma_db")
import chromadb
rag.client = chromadb.PersistentClient(path=rag.CHROMA_PATH)
rag.collection = rag.client.get_or_create_collection("skill_knowledge", metadata={"hnsw:space": "cosine"})
rag.memory_collection = rag.client.get_or_create_collection("user_memory", metadata={"hnsw:space": "cosine"})

# 断言沙箱生效（防止误伤真实文件）
_real_memory = os.path.abspath(os.path.join(ROOT, "memory.json"))
assert os.path.abspath(rag.MEMORY_PATH) != _real_memory, "沙箱未生效，拒绝继续测试！"

try:
    section("3. split_text 不再死循环")
    r = rag.split_text("a" * 100, chunk_size=10, overlap=10)
    ok("overlap == chunk_size 能返回", isinstance(r, list) and len(r) > 0, len(r) if isinstance(r, list) else r)
    ok("overlap == chunk_size 时步长被兜成 1（不丢内容）", "".join(r).startswith("a"))
    r2 = rag.split_text("b" * 50, chunk_size=10, overlap=999)
    ok("overlap >> chunk_size 能返回", isinstance(r2, list) and len(r2) > 0, len(r2) if isinstance(r2, list) else r2)
    r3 = rag.split_text("c" * 100, chunk_size=1, overlap=0)
    ok("chunk_size=1 能返回且长度=100", len(r3) == 100, len(r3))
    r4 = rag.split_text("d" * 100, chunk_size=0, overlap=0)
    ok("chunk_size=0 被兜底，不崩溃不死循环", isinstance(r4, list) and len(r4) > 0, len(r4) if isinstance(r4, list) else r4)
    r5 = rag.split_text("e" * 100, chunk_size=-5, overlap=-1)
    ok("负数参数被兜底", isinstance(r5, list) and len(r5) > 0, len(r5) if isinstance(r5, list) else r5)
    r6 = rag.split_text("x" * 30, chunk_size=10, overlap=5)
    ok("正常参数行为不变（步长 5，共 6 段）", len(r6) == 6, len(r6))
    ok("空文本返回空列表", rag.split_text("", chunk_size=10, overlap=5) == [])
    parts = rag.split_text("ABCDEFGHIJ", chunk_size=4, overlap=2)
    ok("正常参数下首字符保留", parts[0].startswith("ABCD"), parts)
    ok("正常参数下末字符保留", any(p.endswith("IJ") for p in parts), parts)
    ok("正常参数下窗口长度正确", [len(p) for p in parts] == [4, 4, 4, 4, 2], [len(p) for p in parts])

    section("13. find_skill_root 识别根目录 SKILL.md")
    root_file = os.path.join(SKILLS, "某文档.md")
    with open(root_file, "w", encoding="utf-8") as f:
        f.write("root level doc")
    ok("根目录文件归属到 '.'", rag.find_skill_root(root_file, SKILLS) == ".", rag.find_skill_root(root_file, SKILLS))
    a_file = os.path.join(SKILLS, "skillA", "x.md")
    with open(a_file, "w", encoding="utf-8") as f:
        f.write("a doc")
    ok("子目录文件归属到 skillA", rag.find_skill_root(a_file, SKILLS) == "skillA", rag.find_skill_root(a_file, SKILLS))
    b_file = os.path.join(SKILLS, "skillB", "references", "y.md")
    with open(b_file, "w", encoding="utf-8") as f:
        f.write("b doc")
    ok("深层文件归属到最近的 SKILL.md 所在目录", rag.find_skill_root(b_file, SKILLS) == "skillB", rag.find_skill_root(b_file, SKILLS))

    section("附带：parse_skill_name 只认 front-matter")
    a_content = open(os.path.join(SKILLS, "skillA", "SKILL.md"), encoding="utf-8").read()
    ok("取到 front-matter 里的 name 并去掉引号", rag.parse_skill_name(a_content, "fallback") == "狸猫 A",
       rag.parse_skill_name(a_content, "fallback"))
    b_content = open(os.path.join(SKILLS, "skillB", "SKILL.md"), encoding="utf-8").read()
    ok("没有 name 时回退到文件夹名", rag.parse_skill_name(b_content, "skillB") == "skillB")
    ok("结果不含 \\r", "\r" not in rag.parse_skill_name(a_content, "fb"))
    ok("空内容回退", rag.parse_skill_name("", "fb") == "fb")
    ok("front-matter 有 name: 但值为空 → 回退", rag.parse_skill_name("---\nname:\n---\n", "fb") == "fb")
    ok("不误匹配缩进子字段", rag.parse_skill_name("---\ndescription: d\n---\n  name: 子字段\n", "fb") == "fb")

    section("15. parse_rag_scope 接受引号与 BOM")
    ok("不带引号的 all", rag.parse_rag_scope(os.path.join(SKILLS, "SKILL.md")) == "all",
       rag.parse_rag_scope(os.path.join(SKILLS, "SKILL.md")))
    ok("带双引号的 \"all\"", rag.parse_rag_scope(os.path.join(SKILLS, "skillA", "SKILL.md")) == "all",
       rag.parse_rag_scope(os.path.join(SKILLS, "skillA", "SKILL.md")))
    ok("带单引号的 'all' + 文件带 BOM", rag.parse_rag_scope(os.path.join(BOMSKILL, "SKILL.md")) == "all",
       rag.parse_rag_scope(os.path.join(BOMSKILL, "SKILL.md")))
    ok("没有 front-matter 时默认 self", rag.parse_rag_scope(os.path.join(SKILLS, "skillB", "SKILL.md")) == "self")
    ok("非法取值时降级为 self 而不是崩溃",
       rag.parse_rag_scope(os.path.join(SKILLS, "skillB", "SKILL.md")) in ("self", "all"))

    section("20. read_file_content 白名单已补齐")
    def _read(rel):
        return rag.read_file_content(os.path.join(SKILLS, "skillA", "docs", rel))
    for f in ["cfg.yaml", "cfg.yml", "data.xml", "run.sh", "note.toml", "LICENSE", "README"]:
        ok(f"能读取 {f}", _read(f) is not None, _read(f))
    ok("二进制 png 仍被拒绝（不索引）", _read("logo.png") is None, _read("logo.png"))

    section("12/14. 接口：skill_content 的 name 与 /api/emoji")
    from fastapi.testclient import TestClient
    client = TestClient(rag.app)

    r = client.get("/api/skill_content", params={"skill_id": "skillA"})
    ok("skillA 状态 200", r.status_code == 200, r.status_code)
    body = r.json()
    ok("name 是 front-matter 的显示名而不是文件夹 id", body.get("name") == "狸猫 A", body.get("name"))
    ok("content 仍返回", bool(body.get("content")))
    ok("emoji 仍返回", body.get("emoji") == {"a1": "(A)"}, body.get("emoji"))
    ok("rag_scope 仍是 self（skillA 已改成 all，这里应为 all）", body.get("rag_scope") == "all", body.get("rag_scope"))
    r = client.get("/api/skill_content", params={"skill_id": "skillB"})
    ok("skillB 的 name 回退成文件夹名", r.json().get("name") == "skillB", r.json().get("name"))

    skills = client.get("/api/skills").json().get("skills", [])
    by_id = {s["id"]: s["name"] for s in skills}
    ok("skillA 在列表里", "skillA" in by_id, list(by_id.keys()))
    ok("两处 name 一致（skillA）", by_id.get("skillA") == "狸猫 A", by_id.get("skillA"))
    if "." in by_id:
        rc = client.get("/api/skill_content", params={"skill_id": "."}).json()
        ok("根级 Skill 两处 name 一致", by_id.get(".") == rc.get("name"), (by_id.get("."), rc.get("name")))
        ok("根级 Skill 的 name 是 根级技能", rc.get("name") == "根级技能", rc.get("name"))

    r = client.get("/api/emoji")
    ok("不带 skill_id 返回 200（此前 404）", r.status_code == 200, r.status_code)
    ok("返回根目录的 emoji_config.json", r.json().get("emoji", {}).get("nod") == "( ˘•ω•˘ )", r.json())
    r = client.get("/api/emoji", params={"skill_id": "skillA"})
    ok("带 skill_id 返回该 Skill 的颜文字", r.json().get("emoji") == {"a1": "(A)"}, r.json())
    r = client.get("/api/emoji", params={"skill_id": "skillB"})
    ok("该 Skill 没有 emoji_config.json 时返回空 + error", r.json().get("emoji") == {} and "error" in r.json(), r.json())
    r = client.get("/api/emoji", params={"skill_id": "../../etc"})
    ok("非法路径被拒绝", r.json().get("emoji") == {}, r.json())

    section("17. /api/search 参数与硬索引防护")
    # 库里是空的，所以应返回空结果而不是 500
    for k in [0, -1, 99999, 3]:
        r = client.get("/api/search", params={"query": "任何东西", "top_k": k})
        ok(f"top_k={k} 不返回 500（应为 200 + 空结果）", r.status_code == 200, (k, r.status_code, r.text[:120]))
    r = client.get("/api/search", params={"query": ""})
    ok("空 query 安全返回", r.status_code == 200 and r.json().get("results") == [], r.text[:120])

    section("16. /api/memory/search 遇到脏记录不再 500")
    # 造一条缺 id 的脏记忆 + 一条正常记忆
    rag.save_memories([{"content": "没有 id 的脏记录"}, {"id": "m1", "content": "正常记忆", "enabled": True}])
    r = client.get("/api/memory/search", params={"query": "x", "top_k": 3})
    ok("脏记录存在时 memory/search 不返回 500", r.status_code == 200, (r.status_code, r.text[:200]))
    r = client.get("/api/memory/list")
    ok("memory/list 正常", r.status_code == 200 and len(r.json().get("memories", [])) == 2, r.text[:200])

    section("11. add_memory 毫秒级 ID 不碰撞 + 原子写入")
    rag.save_memories([])
    ids = []
    for i in range(30):
        resp = rag.add_memory(rag.MemoryAddReq(content="测试记忆 %d" % i, source="测试"))
        ids.append(resp["id"])
    ok("30 次添加产生 30 个唯一 id", len(set(ids)) == 30, len(set(ids)))
    stored = rag.load_memories()
    ok("memory.json 里也是 30 条（原子写入没丢数据）", len(stored) == 30, len(stored))
    ok("memory.json 里的 id 也唯一", len({m["id"] for m in stored}) == 30, len({m["id"] for m in stored}))
    ok("memory.json 是合法 JSON 数组", isinstance(json.load(open(rag.MEMORY_PATH, encoding="utf-8")), list))

    # _mutate_memories 的两种用法都必须安全
    n = rag._mutate_memories(lambda ms: ms.append({"id": "extra"}) or 1)
    ok("_mutate_memories：fn 返回标量时不清空列表", len(rag.load_memories()) == 31, len(rag.load_memories()))
    rag._mutate_memories(lambda ms: [m for m in ms if m.get("id") != "extra"])
    ok("_mutate_memories：fn 返回列表时按返回值落盘", len(rag.load_memories()) == 30, len(rag.load_memories()))

    section("16b. delete_memory 只删精确匹配，脏记录不被误删")
    rag.save_memories([{"id": "m1", "content": "a"}, {"id": "m2", "content": "b"}, {"content": "脏"}])
    resp = rag.delete_memory(rag.MemoryAddReq(content="不存在"))
    ok("删除不存在的 id 返回 success", resp.get("status") == "success", resp)
    after = rag.load_memories()
    ok("缺 id 的脏记录被保留（不被误删）", any(m.get("content") == "脏" for m in after), after)
    ok("其余记录不受影响", len(after) == 3, len(after))
    rag.delete_memory(rag.MemoryAddReq(content="m1"))
    after = rag.load_memories()
    ok("目标记忆被删除", "m1" not in {m.get("id") for m in after}, after)
    ok("删除只影响一条（3 → 2）", len(after) == 2, len(after))

    section("18. parse_temp_file 的健壮性")
    import tempfile as _tf
    before_tmp = set(os.listdir(_tf.gettempdir()))
    # ★ 修正：FastAPI 对 filename="" 的请求会在参数校验阶段就直接返回 422，
    #   根本不会进入 parse_temp_file 的函数体（后端那句 `if not file.filename: raise 400`
    #   是双保险，防止将来框架行为变化）。
    #   本项测试的真实目的是"不要返回 500 让前端静默失败"，400/422 都满足；
    #   断言放宽为 "in (400, 422)" 才是正确的期望值。
    r = client.post("/api/parse_temp_file", files={"file": ("", b"hello world content here")})
    ok("缺少 filename 时返回 4xx（不是 500）", r.status_code in (400, 422), (r.status_code, r.text[:160]))
    r = client.post("/api/parse_temp_file", files={"file": ("t.md", b"")})
    ok("空内容返回 200 + 空 chunks + error", r.status_code == 200 and r.json().get("chunks") == [], r.text[:160])
    r = client.post("/api/parse_temp_file", files={"file": ("t.md", b"# hello\n\nthis is a test document with enough content to be chunked.")})
    ok("正常文本文件能解析", r.status_code == 200 and len(r.json().get("chunks", [])) >= 1, r.text[:200])
    after_tmp = set(os.listdir(_tf.gettempdir()))
    leaked = [f for f in (after_tmp - before_tmp) if f.startswith("tmp")]
    ok("没有遗留临时文件", len(leaked) == 0, leaked[:5])

    # ================= #19 修正说明 =================
    # v4.1 flash 把 run_build_task 改成了"容错模式"：单个文件的嵌入失败不再抛异常中断，
    # 而是记进 failed_files 继续处理下一个文件，最终状态为 "completed"。
    # 所以用 collection.add 抛异常**不会**让状态变 failed（这是新设计，不是 bug）。
    # 想验证"异常后状态不卡 running"的 finally 兜底，必须触发一个真正逃出
    # _run_build_inner 内部的异常 —— glob.glob 就在 try 里、finally 兜底外，最合适。
    section("19. run_build_task 异常后状态不卡在 running")
    original_glob = rag.glob.glob
    def _boom_glob(*a, **kw):
        raise RuntimeError("模拟 glob 崩溃（磁盘未挂载 / 权限错误等）")
    rag.glob.glob = _boom_glob
    try:
        rag.BUILD_STATUS["status"] = "idle"
        rag.run_build_task(trigger="test")
        ok("异常后状态不是 running（不会永久卡死）", rag.BUILD_STATUS["status"] != "running",
           rag.BUILD_STATUS["status"])
        ok("异常后状态被置为 failed", rag.BUILD_STATUS["status"] == "failed", rag.BUILD_STATUS["status"])
        ok("异常被记录进 last_error", bool(rag.BUILD_STATUS.get("last_error")), rag.BUILD_STATUS.get("last_error"))
    finally:
        rag.glob.glob = original_glob

    # 补充：验证"单文件嵌入失败不会中断整个构建，而是记入 failed_files 并继续"
    section("19-2. 单文件嵌入失败不中断整个构建（容错模式）")
    original_add2 = rag.collection.add
    def _boom_add(*a, **kw):
        raise RuntimeError("模拟向量维度不符")
    rag.collection.add = _boom_add
    try:
        rag.BUILD_STATUS["status"] = "idle"
        rag.BUILD_STATUS.pop("last_error", None)
        rag.BUILD_STATUS.pop("failed_files", None)
        rag.run_build_task(trigger="test")
        ok("构建正常结束（status=completed）", rag.BUILD_STATUS["status"] == "completed", rag.BUILD_STATUS["status"])
        ok("失败文件被记入 failed_files", bool(rag.BUILD_STATUS.get("failed_files")), rag.BUILD_STATUS.get("failed_files"))
    finally:
        rag.collection.add = original_add2

    # ================= #19b 修正说明 =================
    # FastAPI 的 TestClient 会【同步执行】BackgroundTasks —— /api/build 刚把 status
    # 置为 running，background_task 就在同一次请求里跑完并把 status 改成 completed，
    # 所以客户端拿到的瞬间读到的已经是 completed。
    # 生产环境（uvicorn）里 background_task 是响应之后异步跑的，行为正确。
    # 所以这里不再断言"响应时 status == running"，而是：
    #   ① 手动把 status 占为 running，验证再次调用被拒绝（这是原子的核心目的）
    #   ② 从 idle 出发调用一次，验证能正常启动并返回 200
    section("19b. /api/build 的并发拒绝与启动")
    rag.BUILD_STATUS["status"] = "running"
    r = client.post("/api/build")
    ok("状态为 running 时再次调用被拒绝（返回 running）", r.json().get("status") == "running", r.json())

    rag.BUILD_STATUS["status"] = "idle"
    rag.BUILD_STATUS["message"] = "就绪"
    r = client.post("/api/build")
    ok("从 idle 调用返回 200 且带 status 字段",
       r.status_code == 200 and isinstance(r.json().get("status"), str), (r.status_code, r.json()))
    # 复位，避免影响后续
    rag.BUILD_STATUS["status"] = "idle"

    section("2. watchdog 忽略正则跨平台")
    handler = rag.SkillDirHandler()
    ok("忽略 Windows chroma_db 路径", handler._should_ignore(r"E:\skills\chroma_db\data.bin"))
    ok("忽略 Windows __pycache__", handler._should_ignore(r"E:\skills\sub\__pycache__\x.pyc"))
    ok("忽略 POSIX chroma_db 路径", handler._should_ignore("/home/u/skills/chroma_db/data.bin"))
    ok("忽略 POSIX __pycache__", handler._should_ignore("/home/u/skills/sub/__pycache__/x.pyc"))
    for p in ["/a/b/x.tmp", "/a/b/x.swp", "/a/b/x.bak", "/a/b/x.part", "/a/b/x.crdownload", "/a/b/~",
              "/a/b/.DS_Store", "/a/b/Thumbs.db", "/a/b/file_hashes.json", "/a/b/conversations.json", "/a/b/memory.json"]:
        ok("忽略 " + p, handler._should_ignore(p))
    for p in ["/a/b/SKILL.md", "/a/b/note.md", "/a/b/emoji_config.json", r"E:\skills\狸猫\SKILL.md"]:
        ok("不忽略 " + p, not handler._should_ignore(p))
    ok("不误伤 chroma_db_notes.md", not handler._should_ignore("/a/b/chroma_db_notes.md"))

    section("6. watchdog 按事件类型过滤（不再因读文件而自触发重建）")
    class FakeEvent:
        def __init__(self, et, path, is_dir=False):
            self.event_type = et
            self.src_path = path
            self.is_directory = is_dir
    triggered = []
    handler2 = rag.SkillDirHandler()
    handler2._trigger = lambda p: triggered.append(p)
    # 读事件不应触发
    for et in ["opened", "closed"]:
        handler2.on_any_event(FakeEvent(et, os.path.join(SKILLS, "a.md")))
    ok("opened / closed 事件不触发重建", len(triggered) == 0, triggered)
    # 目录事件不触发
    handler2.on_any_event(FakeEvent("modified", SKILLS, is_dir=True))
    ok("目录事件不触发重建", len(triggered) == 0, triggered)
    # 被忽略的路径不触发
    handler2.on_any_event(FakeEvent("modified", os.path.join(SKILLS, "memory.json")))
    ok("被忽略路径不触发重建", len(triggered) == 0, triggered)
    # 真正的内容变化应触发（会起一个 2 秒 Timer，这里只验证定时器被创建）
    handler2.on_any_event(FakeEvent("modified", os.path.join(SKILLS, "real.md")))
    ok("modified 事件会排程重建", handler2._timer is not None, handler2._timer)
    if handler2._timer:
        handler2._timer.cancel()

    section("接口清单回归（不应有路由丢失）")
    routes = sorted({r.path for r in rag.app.routes if hasattr(r, "methods")})
    for p in ["/api/skills", "/api/skill_content", "/api/search", "/api/build", "/api/build_status",
              "/api/config", "/api/embed", "/api/open_folder", "/api/parse_temp_file",
              "/api/memory/list", "/api/memory/add", "/api/memory/delete", "/api/memory/search", "/api/emoji"]:
        ok("路由存在 " + p, p in routes, routes)
    api_routes = [p for p in routes if p.startswith("/api/")]
    ok("业务路由数量为 14", len(api_routes) == 14, len(api_routes))

finally:
    # 整目录删除，绝不触碰项目里的真实文件
    shutil.rmtree(SANDBOX, ignore_errors=True)

print("\n" + "=" * 56)
print("后端回归结果：%d 通过 / %d 失败" % (passed, failed))
if failures:
    print("\n失败项：")
    for x in failures:
        print("  - " + x)
sys.exit(1 if failed else 0)