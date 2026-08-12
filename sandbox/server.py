#!/usr/bin/env python3
"""
server.py — Persistent Sandbox HTTP Service
===========================================
把 runner.py 包装成一个长期运行的 Flask HTTP 服务。
每个 POST /run 请求 fork 独立子进程运行 runner 逻辑，立刻返回 job_id，
子进程通过 CALLBACK_URL 把结果回写主服务（和 Cloud Run Job 模式完全一样）。

优势：Cloud Run Service 支持 min-instances=1，消灭冷启动。
"""

import os
import sys
import json
import subprocess
import threading
import time
import uuid
from flask import Flask, request, jsonify

app = Flask(__name__)

# 沙箱服务认证 secret（和 Cloud Run Job 的 SANDBOX_SECRET 一致）
SANDBOX_SECRET = os.environ.get("SANDBOX_SECRET", "sandbox-secret-2024")

# 每个请求的最大执行时间（秒），超时后子进程被 kill
MAX_EXEC_SECONDS = int(os.environ.get("MAX_EXEC_SECONDS", "2100"))  # 35 分钟

# 运行中的子进程 {job_id: Popen}
_jobs: dict = {}
_jobs_lock = threading.Lock()

# ── 启动时预加载 SKILL_MD 缓存 {skill_id: markdown_text} ──────────────────────
_skill_cache: dict = {}
_skill_cache_lock = threading.Lock()

def _preload_skill_cache():
    """后台线程：服务启动后异步拉取所有 SKILL_MD，避免每个 job 都去 DB fetch（省 7-12s）"""
    import psycopg2 as _pg
    db_url = os.environ.get("DATABASE_URL", "")
    db_schema = os.environ.get("DB_SCHEMA", "skill_platform")
    if not db_url:
        return
    try:
        t0 = time.time()
        sep = "&" if "?" in db_url else "?"
        conn = _pg.connect(db_url + sep + "gssencmode=disable", connect_timeout=15)
        with conn.cursor() as cur:
            cur.execute(f'SELECT id, prompt_template FROM "{db_schema}".skills WHERE prompt_template IS NOT NULL')
            rows = cur.fetchall()
        conn.close()
        with _skill_cache_lock:
            for skill_id, prompt in rows:
                _skill_cache[str(skill_id)] = prompt
        elapsed = round(time.time() - t0, 2)
        print(f"[cache] preloaded {len(_skill_cache)} skills in {elapsed}s", flush=True)
    except Exception as e:
        print(f"[cache] preload failed: {e}", flush=True)

def _fetch_single_skill(skill_id: str) -> str:
    """按需单条读取（cache miss 时），gssencmode=disable 避免 IPv6 10s 超时"""
    import psycopg2 as _pg
    db_url = os.environ.get("DATABASE_URL", "")
    db_schema = os.environ.get("DB_SCHEMA", "skill_platform")
    if not db_url or not skill_id:
        return ""
    try:
        t0 = time.time()
        sep = "&" if "?" in db_url else "?"
        conn = _pg.connect(db_url + sep + "gssencmode=disable", connect_timeout=12)
        with conn.cursor() as cur:
            cur.execute(f'SELECT prompt_template FROM "{db_schema}".skills WHERE id = %s', (skill_id,))
            row = cur.fetchone()
        conn.close()
        elapsed = round(time.time() - t0, 2)
        if row and row[0]:
            print(f"[cache] on-demand fetch skill_id={skill_id} in {elapsed}s ({len(row[0])} chars)", flush=True)
            with _skill_cache_lock:
                _skill_cache[skill_id] = row[0]   # 写入缓存，下次不用再 fetch
            return row[0]
        print(f"[cache] on-demand fetch: skill_id={skill_id} not found ({elapsed}s)", flush=True)
    except Exception as e:
        print(f"[cache] on-demand fetch failed: {e}", flush=True)
    return ""

# 服务启动时异步预加载（不阻塞启动）
threading.Thread(target=_preload_skill_cache, daemon=True).start()


@app.route("/health", methods=["GET"])
def health():
    """GCP Cloud Run 健康检查端点"""
    with _jobs_lock:
        active = len(_jobs)
    with _skill_cache_lock:
        cached = len(_skill_cache)
    return jsonify({"status": "ok", "active_jobs": active, "cached_skills": cached}), 200


@app.route("/run", methods=["POST"])
def run():
    """
    接收工单执行请求，立刻 fork 子进程跑 runner.py，立刻返回 job_id。
    子进程完成后通过 callback_url 把结果回写主服务（与 Cloud Run Job 行为一致）。

    Request body（JSON）：
        skill_id, user_inputs, model, ai_key, ai_base_url,
        fallback_ai_key, fallback_ai_base, fallback_model,
        database_url, db_schema, callback_url, sandbox_secret,
        mcp_configs, oauth_tokens, case_count, ticket_mode,
        tavily_api_key
    """
    # ── 认证 ────────────────────────────────────────────────────────────────
    auth = request.headers.get("X-Sandbox-Secret", "")
    if auth != SANDBOX_SECRET:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(silent=True) or {}

    skill_id = body.get("skill_id", "")
    if not skill_id:
        return jsonify({"error": "skill_id is required"}), 400

    job_id = f"svc-{uuid.uuid4().hex[:12]}"

    # ── 构建子进程环境变量（和 Cloud Run Job 的 envVars 完全对应）──────────
    env = dict(os.environ)

    # 如果缓存命中，直接把 SKILL_MD 传给子进程（省去 DB fetch 7-12s）
    import base64 as _b64
    with _skill_cache_lock:
        cached_skill_md = _skill_cache.get(skill_id, "")

    # cache miss 时，server 自己同步按需 fetch（保证 SKILL_MD 永远不为空）
    if not cached_skill_md:
        cached_skill_md = _fetch_single_skill(skill_id)

    skill_md_b64 = _b64.b64encode(cached_skill_md.encode()).decode() if cached_skill_md else ""
    if cached_skill_md:
        print(f"[server] cache hit: skill_id={skill_id} ({len(cached_skill_md)} chars)", flush=True)
    else:
        print(f"[server] WARNING: SKILL_MD empty for skill_id={skill_id}", flush=True)

    env.update({
        "SKILL_ID":             skill_id,
        "SKILL_MD":             skill_md_b64,  # base64(SKILL_MD)，runner.py 优先用此值（省 DB fetch）
        "USER_INPUTS":          json.dumps(body.get("user_inputs", {})),
        "AI_MODEL":             body.get("model", ""),
        "AI_API_KEY":           body.get("ai_key", ""),
        "AI_BASE_URL":          body.get("ai_base_url", ""),
        "AI_CHAT_URL":          (body.get("ai_base_url", "") + "/chat/completions")
                                    if body.get("ai_base_url") else "",
        "FALLBACK_AI_API_KEY":  body.get("fallback_ai_key", ""),
        "FALLBACK_AI_BASE_URL": body.get("fallback_ai_base", ""),
        "FALLBACK_AI_MODEL":    body.get("fallback_model", "deepseek-chat"),
        "DATABASE_URL":         body.get("database_url", os.environ.get("DATABASE_URL", "")),
        "DB_SCHEMA":            body.get("db_schema", os.environ.get("DB_SCHEMA", "skill_platform")),
        "CALLBACK_URL":         body.get("callback_url", ""),
        "SANDBOX_SECRET":       body.get("sandbox_secret", SANDBOX_SECRET),
        "MCP_CONFIGS":          body.get("mcp_configs", "[]"),
        "OAUTH_TOKENS":         body.get("oauth_tokens", ""),
        "CASE_COUNT":           str(max(1, min(3, int(body.get("case_count", 1))))),
        "TICKET_MODE":          "1" if body.get("ticket_mode") else "0",
        "TAVILY_API_KEY":       body.get("tavily_api_key", os.environ.get("TAVILY_API_KEY", "")),
        "SVC_JOB_ID":           job_id,
    })

    # ── 启动子进程 ──────────────────────────────────────────────────────────
    runner_path = os.path.join(os.path.dirname(__file__), "runner.py")
    proc = subprocess.Popen(
        [sys.executable, runner_path],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    with _jobs_lock:
        _jobs[job_id] = proc

    # ── 后台线程：等待完成 + 超时 kill ─────────────────────────────────────
    def _monitor(job_id: str, proc: subprocess.Popen, timeout: int):
        deadline = time.time() + timeout
        try:
            # 实时转发子进程输出到 Cloud Logging（便于调试）
            for line in proc.stdout:
                print(f"[job:{job_id}] {line.rstrip()}", flush=True)
                if time.time() > deadline:
                    proc.kill()
                    print(f"[server] job {job_id} KILLED after {timeout}s timeout", flush=True)
                    break
            proc.wait()
            print(f"[server] job {job_id} done (rc={proc.returncode})", flush=True)
        except Exception as e:
            proc.kill()
            print(f"[server] job {job_id} monitor error: {e}", flush=True)
        finally:
            with _jobs_lock:
                _jobs.pop(job_id, None)

    t = threading.Thread(target=_monitor, args=(job_id, proc, MAX_EXEC_SECONDS), daemon=True)
    t.start()

    print(f"[server] started job {job_id} for skill_id={skill_id} (pid={proc.pid})", flush=True)
    return jsonify({"job_id": job_id, "pid": proc.pid}), 202


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    """简单状态查询（running/done）"""
    with _jobs_lock:
        running = job_id in _jobs
    return jsonify({"job_id": job_id, "status": "running" if running else "done"}), 200


@app.route("/diag", methods=["GET"])
def diag():
    """
    /diag — 诊断各环节耗时，无需认证（仅调试用）
    测量：
    1. DNS 解析顺序（IPv4 vs IPv6，影响 DB 连接速度）
    2. DB 冷连接耗时
    3. subprocess 冷启动（import psycopg2 + openai 时间）
    4. LLM 第一次调用延迟（不含/含 tools）
    5. SKILL_MD 缓存状态
    """
    import time, socket, re, sys
    results = {"ts": time.time()}
    t_start = time.time()

    # ── 0. SKILL_MD 缓存状态 ───────────────────────────────────────────────
    with _skill_cache_lock:
        results["cache_skills"] = len(_skill_cache)
        results["cache_skill_ids"] = list(_skill_cache.keys())[:5]  # 最多显示前5个

    # ── 1. DNS 解析顺序（直接决定 psycopg2 走 IPv4 还是 IPv6）──────────────
    db_url = os.environ.get("DATABASE_URL", "")
    m = re.search(r"@([^:/]+)", db_url)
    if m:
        hostname = m.group(1)
        try:
            t0 = time.time()
            all_addrs = socket.getaddrinfo(hostname, 5432)
            dns_ms = round((time.time() - t0) * 1000)
            first = all_addrs[0]
            first_family = "IPv6" if first[0] == socket.AF_INET6 else "IPv4"
            results["dns"] = {
                "hostname": hostname,
                "first_family": first_family,
                "first_addr": first[4][0],
                "all_count": len(all_addrs),
                "dns_ms": dns_ms,
            }
        except Exception as e:
            results["dns"] = {"error": str(e)}
    else:
        results["dns"] = {"error": "no DATABASE_URL hostname"}

    # ── 2. DB 冷连接 ──────────────────────────────────────────────────────
    if db_url:
        try:
            import psycopg2
            t0 = time.time()
            sep = "&" if "?" in db_url else "?"
            conn = psycopg2.connect(db_url + sep + "gssencmode=disable", connect_timeout=10)
            conn.close()
            results["db_connect_ms"] = round((time.time() - t0) * 1000)
            results["db_ok"] = True
        except Exception as e:
            results["db_connect_ms"] = round((time.time() - t0) * 1000)
            results["db_ok"] = False
            results["db_error"] = str(e)[:200]
    else:
        results["db_connect_ms"] = None

    # ── 3. subprocess 冷启动（python3 import 时间）────────────────────────
    t0 = time.time()
    try:
        r = subprocess.run(
            [sys.executable, "-c",
             "import time; t=time.time(); import psycopg2; import openai; "
             "print(f'psycopg2+openai import: {time.time()-t:.3f}s')"],
            capture_output=True, text=True, timeout=30
        )
        results["subprocess_import_ms"] = round((time.time() - t0) * 1000)
        results["subprocess_import_output"] = r.stdout.strip()
    except Exception as e:
        results["subprocess_import_ms"] = None
        results["subprocess_import_error"] = str(e)

    # ── 4. LLM 延迟（含/不含 tools）────────────────────────────────────────
    ai_key   = os.environ.get("AI_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
    ai_base  = os.environ.get("AI_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    ai_model = os.environ.get("AI_MODEL", "")
    if ai_key and ai_model:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=ai_key, base_url=ai_base)
            TOOLS = [{"type": "function", "function": {
                "name": "exec",
                "description": "执行 shell 命令",
                "parameters": {"type": "object",
                               "properties": {"command": {"type": "string"}},
                               "required": ["command"]},
            }}]
            # 4a: 无工具
            t0 = time.time()
            r = client.chat.completions.create(
                model=ai_model,
                messages=[{"role": "user", "content": "回复'ok'即可"}],
                max_tokens=10, timeout=30,
            )
            results["llm_no_tools_ms"] = round((time.time() - t0) * 1000)
            results["llm_no_tools_ok"] = True
            # 4b: 带 tools
            t0 = time.time()
            r = client.chat.completions.create(
                model=ai_model,
                messages=[
                    {"role": "system", "content": "你是 AI 营养顾问。" * 30},
                    {"role": "user",   "content": "用户45岁男性高血压，请先搜索最新高血压饮食指南。"},
                ],
                tools=TOOLS, tool_choice="auto",
                max_tokens=512, timeout=60,
            )
            elapsed = round((time.time() - t0) * 1000)
            results["llm_with_tools_ms"] = elapsed
            results["llm_with_tools_finish"] = r.choices[0].finish_reason
            results["llm_ok"] = True
        except Exception as e:
            results["llm_error"] = str(e)[:300]
            results["llm_ok"] = False
    else:
        results["llm_ok"] = None
        results["llm_skip"] = f"AI_API_KEY={'set' if ai_key else 'missing'}, AI_MODEL={ai_model!r}"

    results["total_diag_ms"] = round((time.time() - t_start) * 1000)
    return jsonify(results), 200


@app.route("/bench", methods=["GET"])
def bench():
    """
    /bench — 测量纯 AI streaming 耗时（从缓存读取 SKILL_MD，跳过 DB/subprocess 开销）
    返回：first_token_ms, total_ms, tokens, cache_hit
    """
    import time as _t
    results = {"ts": _t.time()}

    ai_key   = os.environ.get("AI_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
    ai_base  = os.environ.get("AI_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    ai_model = os.environ.get("AI_MODEL", "")

    with _skill_cache_lock:
        cache_size = len(_skill_cache)
        skill_md = next(iter(_skill_cache.values()), None) if _skill_cache else None

    results["cache_skills"] = cache_size
    results["skill_md_chars"] = len(skill_md) if skill_md else 0
    results["cache_hit"] = skill_md is not None

    if not ai_key or not ai_model:
        results["error"] = f"missing: AI_API_KEY={'set' if ai_key else 'MISSING'}, AI_MODEL={ai_model!r}"
        return jsonify(results), 200

    if not skill_md:
        results["error"] = "skill cache empty, wait for preload or trigger a /run first"
        return jsonify(results), 200

    try:
        from openai import OpenAI
        client = OpenAI(api_key=ai_key, base_url=ai_base)
        TOOLS = [{"type": "function", "function": {
            "name": "exec",
            "description": "执行 bash 命令",
            "parameters": {"type": "object",
                           "properties": {"command": {"type": "string"}},
                           "required": ["command"]},
        }}]
        t0 = _t.time()
        first_token_ms = None
        total_tokens = 0
        stream = client.chat.completions.create(
            model=ai_model,
            messages=[
                {"role": "system", "content": skill_md[:3000]},
                {"role": "user",   "content": "用户: 42岁男性，身高178cm体重75kg，请开始分析"},
            ],
            tools=TOOLS, tool_choice="auto",
            max_tokens=256, timeout=60,
            stream=True,
        )
        for chunk in stream:
            if first_token_ms is None:
                first_token_ms = round((_t.time() - t0) * 1000)
            if chunk.usage:
                total_tokens = chunk.usage.total_tokens
        results["first_token_ms"] = first_token_ms
        results["total_ms"] = round((_t.time() - t0) * 1000)
        results["total_tokens"] = total_tokens
        results["ok"] = True
    except Exception as e:
        results["error"] = str(e)[:300]
        results["ok"] = False

    return jsonify(results), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] Persistent Sandbox Service starting on port {port}", flush=True)
    # 生产环境由 gunicorn 启动，此处仅供本地调试
    app.run(host="0.0.0.0", port=port, threaded=True)
