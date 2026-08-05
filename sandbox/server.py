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


@app.route("/health", methods=["GET"])
def health():
    """GCP Cloud Run 健康检查端点"""
    with _jobs_lock:
        active = len(_jobs)
    return jsonify({"status": "ok", "active_jobs": active}), 200


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
    env.update({
        "SKILL_ID":             skill_id,
        "SKILL_MD":             "",   # runner.py 从 DB 读，此处留空
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
        try:
            stdout, _ = proc.communicate(timeout=timeout)
            print(f"[server] job {job_id} done (rc={proc.returncode}) stdout_len={len(stdout or '')}", flush=True)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            print(f"[server] job {job_id} KILLED after {timeout}s timeout", flush=True)
        except Exception as e:
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] Persistent Sandbox Service starting on port {port}", flush=True)
    # 生产环境由 gunicorn 启动，此处仅供本地调试
    app.run(host="0.0.0.0", port=port, threaded=True)
