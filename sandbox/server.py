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


@app.route("/diag/gemini-ttft", methods=["GET", "POST"])
def diag_gemini_ttft():
    """诊断端点：从 Cloud Run 内部直接请求 Gemini API，测量 TTFT
    GET  ?key=...&model=...  → 简单 prompt 测试
    POST body={key, model, system, user, tools, max_tokens} → 完整复现 runner.py 请求
    GET  ?key=...&mode=full&skill_id=... → 用缓存的 SKILL_MD 自动构建完整请求
    """
    import urllib.request as _ur

    if request.method == "POST":
        d = request.get_json(force=True)
        api_key = d.get("key", "")
        model = d.get("model", "gemini-3.6-flash")
        msgs = d.get("messages") or [
            {"role": "system", "content": d.get("system", "You are helpful.")},
            {"role": "user", "content": d.get("user", "Hello")},
        ]
        tools = d.get("tools")
        max_tokens = d.get("max_tokens", 32)
    else:
        api_key = request.args.get("key", "")
        model = request.args.get("model", "gemini-3.6-flash")
        mode = request.args.get("mode", "simple")
        max_tokens = int(request.args.get("max_tokens", "32"))

        if mode == "full":
            # 用缓存的 SKILL_MD 构建完整请求
            skill_id = request.args.get("skill_id", "a2a53e54-98ca-4980-8b19-c18dea109877")
            with _skill_cache_lock:
                skill_md = _skill_cache.get(skill_id, "")
            if not skill_md:
                skill_md = _fetch_single_skill(skill_id)
            system = skill_md.strip() + "\n\n---\n## 执行规则\n你是一个正在执行上述 Skill 的 AI Agent。\n收集到足够信息后直接输出结论。"
            system += "\n\n📍 第 1 轮 | Context 已用约 0% | 已用 0s"
            user = "[表单提交] AI营养师\n姓名：测试用户\n性别：男\n年龄：42\n身高：178cm\n体重：75kg\n目标：减脂\n活动水平：久坐"
            msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
            tools = [
                {"type":"function","function":{"name":"exec","description":"执行bash命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
                {"type":"function","function":{"name":"write_file","description":"写文件","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}},
                {"type":"function","function":{"name":"read_file","description":"读文件","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
                {"type":"function","function":{"name":"web_search","description":"搜索网络","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
            ]
            max_tokens = 32000
        else:
            prompt = request.args.get("prompt", "Say hello in one word.")
            msgs = [{"role": "user", "content": prompt}]
            tools = None

    if not api_key:
        return jsonify({"error": "pass key"}), 400

    base = "https://generativelanguage.googleapis.com/v1beta/openai"
    req_body = {"model": model, "messages": msgs, "max_tokens": max_tokens, "stream": True}
    if tools:
        req_body["tools"] = tools
        req_body["tool_choice"] = "auto"
    data = json.dumps(req_body).encode()

    req = _ur.Request(f"{base}/chat/completions", data=data,
                      headers={"Authorization": f"Bearer {api_key}",
                                "Content-Type": "application/json"},
                      method="POST")
    t0 = time.time()
    ctx_chars = sum(len(str(m.get("content",""))) for m in msgs)
    result = {"model": model, "body_bytes": len(data), "ctx_chars": ctx_chars,
              "tools": bool(tools), "max_tokens": max_tokens}
    try:
        with _ur.urlopen(req, timeout=180) as r:
            result["connect_ms"] = round((time.time() - t0) * 1000)
            try: r.fp.raw._sock.settimeout(120)
            except: pass
            first = True
            for raw in r:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if not line or not line.startswith("data:"): continue
                p = line[5:].strip()
                if p == "[DONE]": break
                if first:
                    result["ttft_ms"] = round((time.time() - t0) * 1000)
                    first = False
                try:
                    ch = json.loads(p)
                    for c in ch.get("choices", []):
                        if c.get("finish_reason"): result["finish"] = c["finish_reason"]
                        d = c.get("delta", {})
                        if d.get("tool_calls"):
                            result["tool_call"] = d["tool_calls"][0].get("function",{}).get("name")
                except: pass
            result["total_ms"] = round((time.time() - t0) * 1000)
            result["ok"] = True
    except Exception as e:
        result["error"] = str(e)[:200]
        result["total_ms"] = round((time.time() - t0) * 1000)
        result["ok"] = False
    return jsonify(result), 200


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


@app.route("/diag/ssl", methods=["GET"])
def diag_ssl():
    """运行 diag_ssl.py 诊断脚本（在 Cloud Run 容器内测试 SSL 连接）
    可通过 query params 传入: ?key=xxx&base_url=xxx&model=xxx
    """
    import subprocess, sys, pathlib
    # 尝试多个可能的路径
    candidates = [
        "/diag_ssl.py",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "diag_ssl.py"),
    ]
    script_path = None
    for c in candidates:
        if os.path.isfile(c):
            script_path = c
            break
    if not script_path:
        return f"diag_ssl.py not found, tried: {candidates}", 404, {"Content-Type": "text/plain"}
    
    # 从 query params 或 env 获取 key
    ai_key = request.args.get("key", "") or os.environ.get("AI_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
    ai_base = request.args.get("base_url", "") or os.environ.get("AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
    ai_model = request.args.get("model", "") or os.environ.get("AI_MODEL", "gemini-2.0-flash")
    
    env = {**os.environ, "AI_API_KEY": ai_key, "AI_BASE_URL": ai_base, "AI_MODEL": ai_model}
    try:
        r = subprocess.run(
            [sys.executable, script_path],
            capture_output=True, text=True, timeout=300,
            env=env,
        )
        return r.stdout + ("\n--- STDERR ---\n" + r.stderr if r.stderr else ""), 200, {"Content-Type": "text/plain; charset=utf-8"}
    except subprocess.TimeoutExpired:
        return "TIMEOUT after 120s", 504, {"Content-Type": "text/plain"}
    except Exception as e:
        return f"ERROR: {e}", 500, {"Content-Type": "text/plain"}

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



@app.route("/bench_methods", methods=["GET"])
def bench_methods():
    """
    /bench_methods — 在 Cloud Run 内部对比 4 种 Gemini 连接方式的速度
    无需认证（调试用）。使用环境变量里的 AI_API_KEY + AI_BASE_URL。

    参数（query string）：
      model=gemini-2.5-flash   # 可选，默认自动选第一个可用模型
      runs=1                   # 每种方式跑几次，默认 1
    """
    import time as _t, json as _j, urllib.request as _ur, urllib.error as _ue

    ai_key   = request.args.get("key", "") or os.environ.get("AI_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
    ai_base  = request.args.get("base", os.environ.get("AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai"))
    model    = request.args.get("model", os.environ.get("AI_MODEL", "gemini-2.5-flash"))
    runs     = max(1, min(3, int(request.args.get("runs", "1"))))
    pad_size = int(request.args.get("pad", "0"))   # 填充到指定字符数，模拟真实工单 context 大小

    _real_system = (
        "你是一位 AI 全维度营养顾问，提供专业的营养分析和饮食建议。\n"
        "你的任务是根据用户的个人信息和健康目标，生成详细的营养方案。\n"
        "请使用科学依据（中国居民膳食指南2022、DASH饮食法等）作为参考。\n"
        "回答要简洁专业，控制在 200 字以内。"
    )
    _real_user = (
        "用户信息：42岁男性，身高178cm，体重75kg，BMI=23.67，久坐办公，"
        "每天做饭时间约30分钟，偏好外卖和偏咸口味。\n"
        "健康需求：改善睡眠、控制血压、优化外卖饮食选择。\n"
        "请简单介绍 DASH 饮食法对高血压的作用，并给出3条具体建议。"
    )

    sys_content = _real_system
    if pad_size > len(sys_content):
        _pad_chunk = (
            "营养素参考摄入量DRIs是评估个体营养摄入是否适宜的标准。"
            "DASH饮食强调多摄入蔬菜水果全谷物低脂乳制品，减少钠饱和脂肪和红肉摄入。"
            "研究显示DASH饮食可使收缩压降低8-14mmHg，是经临床验证的降压饮食方案。"
            "中医体质分型包括平和质气虚质阳虚质阴虚质痰湿质湿热质血瘀质气郁质特禀质九种。"
            "运动营养学关注运动前中后的营养补充策略以优化运动表现和恢复。"
            "特殊人群营养包括孕期哺乳期婴幼儿青少年老年等各阶段的营养需求。"
            "肠道菌群与营养吸收免疫调节和代谢健康密切相关，益生菌和益生元有助于维持菌群平衡。"
        )
        while len(sys_content) < pad_size:
            sys_content += _pad_chunk[:pad_size - len(sys_content)]

    MSGS = [
        {"role": "system", "content": sys_content},
        {"role": "user",   "content": _real_user},
    ]
    MAX_TOK = 256
    _total_chars = sum(len(m["content"]) for m in MSGS)

    results = {"model": model, "base": ai_base, "runs": runs,
               "input_chars": _total_chars, "pad_size": pad_size, "methods": {}}

    if not ai_key:
        return jsonify({"error": "no AI_API_KEY in env"}), 500

    def _run_urllib():
        body = _j.dumps({"model": model, "messages": MSGS, "max_tokens": MAX_TOK, "stream": True}).encode()
        req = _ur.Request(f"{ai_base}/chat/completions", data=body,
                          headers={"Authorization": f"Bearer {ai_key}", "Content-Type": "application/json"},
                          method="POST")
        t0 = _t.time()
        r = {"method": "urllib (当前实现)", "ok": False}
        try:
            with _ur.urlopen(req, timeout=90) as resp:
                r["connect_ms"] = round((_t.time() - t0) * 1000)
                first = True; content = ""; chunks = 0
                for raw in resp:
                    line = raw.decode("utf-8", errors="replace").rstrip()
                    if not line or not line.startswith("data:"): continue
                    p = line[5:].strip()
                    if p == "[DONE]": break
                    try: ch = _j.loads(p)
                    except: continue
                    chunks += 1
                    if first: r["ttft_ms"] = round((_t.time() - t0) * 1000); first = False
                    for c in ch.get("choices", []):
                        if c.get("delta", {}).get("content"): content += c["delta"]["content"]
            r.update({"ok": True, "total_ms": round((_t.time()-t0)*1000),
                      "chunks": chunks, "content_len": len(content), "preview": content[:60]})
        except Exception as e:
            r.update({"error": str(e)[:200], "total_ms": round((_t.time()-t0)*1000)})
        return r

    def _run_openai_sdk():
        r = {"method": "openai SDK (httpx, HTTP/1.1)", "ok": False}
        t0 = _t.time()
        try:
            from openai import OpenAI
            client = OpenAI(api_key=ai_key, base_url=ai_base, timeout=90)
            stream = client.chat.completions.create(model=model, messages=MSGS, max_tokens=MAX_TOK, stream=True)
            first = True; content = ""; chunks = 0
            for chunk in stream:
                chunks += 1
                if first: r["connect_ms"] = r["ttft_ms"] = round((_t.time()-t0)*1000); first = False
                if chunk.choices and chunk.choices[0].delta.content:
                    content += chunk.choices[0].delta.content
            r.update({"ok": True, "total_ms": round((_t.time()-t0)*1000),
                      "chunks": chunks, "content_len": len(content), "preview": content[:60]})
        except Exception as e:
            r.update({"error": str(e)[:200], "total_ms": round((_t.time()-t0)*1000)})
        return r

    def _run_httpx():
        r = {"method": "httpx 直连 HTTP/2", "ok": False}
        t0 = _t.time()
        try:
            import httpx
            body = {"model": model, "messages": MSGS, "max_tokens": MAX_TOK, "stream": True}
            headers = {"Authorization": f"Bearer {ai_key}", "Content-Type": "application/json"}
            # 尝试 HTTP/2，没有 h2 包时降级到 HTTP/1.1
            try:
                http2 = True
                test_client = httpx.Client(http2=True)
                test_client.close()
                r["method"] = "httpx HTTP/2"
            except Exception:
                http2 = False
                r["method"] = "httpx HTTP/1.1 (h2未安装)"
            with httpx.Client(http2=http2, timeout=90) as client:
                with client.stream("POST", f"{ai_base}/chat/completions",
                                   json=body, headers=headers) as resp:
                    resp.raise_for_status()
                    r["connect_ms"] = round((_t.time()-t0)*1000)
                    first = True; content = ""; chunks = 0
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"): continue
                        p = line[5:].strip()
                        if p == "[DONE]": break
                        try: ch = _j.loads(p)
                        except: continue
                        chunks += 1
                        if first: r["ttft_ms"] = round((_t.time()-t0)*1000); first = False
                        for c in ch.get("choices", []):
                            if c.get("delta", {}).get("content"): content += c["delta"]["content"]
            r.update({"ok": True, "total_ms": round((_t.time()-t0)*1000),
                      "chunks": chunks, "content_len": len(content), "preview": content[:60],
                      "http2": http2})
        except Exception as e:
            r.update({"error": str(e)[:200], "total_ms": round((_t.time()-t0)*1000)})
        return r

    def _run_genai_sdk():
        r = {"method": "google-genai SDK (native)", "ok": False}
        t0 = _t.time()
        try:
            import google.genai as _genai
            import google.genai.types as _gtypes
            client = _genai.Client(api_key=ai_key)
            content = ""
            first = True
            chunks = 0
            for chunk in client.models.generate_content_stream(
                model=model,
                contents=MSGS[1]["content"],
                config=_gtypes.GenerateContentConfig(
                    system_instruction=MSGS[0]["content"],
                    max_output_tokens=MAX_TOK,
                ),
            ):
                chunks += 1
                if first:
                    r["connect_ms"] = r["ttft_ms"] = round((_t.time()-t0)*1000)
                    first = False
                if chunk.text:
                    content += chunk.text
            r.update({"ok": True, "total_ms": round((_t.time()-t0)*1000),
                      "chunks": chunks, "content_len": len(content), "preview": content[:60]})
        except Exception as e:
            r.update({"error": str(e)[:300], "total_ms": round((_t.time()-t0)*1000)})
        return r

    benches = [_run_urllib, _run_openai_sdk, _run_httpx, _run_genai_sdk]

    for fn in benches:
        name = fn.__name__
        run_results = []
        for i in range(runs):
            run_results.append(fn())
            if i < runs - 1:
                _t.sleep(2)
        results["methods"][name] = run_results

    # 汇总
    summary = []
    for name, runs_list in results["methods"].items():
        ok = [r for r in runs_list if r.get("ok")]
        method_name = runs_list[0].get("method", name) if runs_list else name
        if ok:
            def avg(k): return round(sum(r.get(k) or 0 for r in ok) / len(ok))
            summary.append({
                "method": method_name,
                "ok_runs": len(ok),
                "connect_ms_avg": avg("connect_ms"),
                "ttft_ms_avg": avg("ttft_ms"),
                "total_ms_avg": avg("total_ms"),
                "chunks_avg": round(sum(r.get("chunks",0) for r in ok)/len(ok)),
            })
        else:
            summary.append({"method": method_name, "ok_runs": 0,
                            "error": runs_list[0].get("error","?")[:100] if runs_list else "?"})
    results["summary"] = summary
    return jsonify(results), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] Persistent Sandbox Service starting on port {port}", flush=True)
    # 生产环境由 gunicorn 启动，此处仅供本地调试
    app.run(host="0.0.0.0", port=port, threaded=True)
