"""
sandbox/runner.py  — AI Agent sandbox runner
参考 OpenClaw bash-tools 设计，AI 读 SKILL.md 然后用 exec 工具执行任务
"""
import os, sys, json, subprocess, time, textwrap, base64, re, shlex, signal
from datetime import datetime, timezone

# OpenClaw 风格模块
from transcript import TranscriptManager
from truncation import truncate_tool_result, calculate_max_chars, truncate_messages_aggregate
from redact import redact_secrets

# ─── 环境变量 ─────────────────────────────────────────────────────────────────
SKILL_ID      = os.environ.get("SKILL_ID", "")
SKILL_MD_B64  = os.environ.get("SKILL_MD", "")          # base64 向后兼容（大 Skill 时为空）
USER_INPUTS   = json.loads(os.environ.get("USER_INPUTS", "{}"))
AI_API_KEY    = os.environ.get("AI_API_KEY", "")
AI_BASE_URL   = os.environ.get("AI_BASE_URL", "")       # doubao/deepseek endpoint
AI_MODEL      = os.environ.get("AI_MODEL", "")
DB_URL        = os.environ.get("DATABASE_URL", "")
DB_SCHEMA     = os.environ.get("DB_SCHEMA", "skill_platform")

def _fetch_skill_md_from_db() -> str:
    """
    OpenClaw 理念：从 DB 按 SKILL_ID 读取 prompt_template。
    类比 OpenClaw 的「agent 用 read_file 工具从磁盘读 SKILL.md」——
    内容不经过 env var，彻底规避 Cloud Run Job 32KB 限制。
    """
    if not SKILL_ID or not DB_URL:
        return ""
    try:
        import psycopg2
        conn = psycopg2.connect(DB_URL, connect_timeout=10)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f'SELECT prompt_template FROM "{DB_SCHEMA}".skills WHERE id = %s',
                    (SKILL_ID,)
                )
                row = cur.fetchone()
        conn.close()
        if row and row[0]:
            print(f"[runner] SKILL_MD loaded from DB: {len(row[0])} chars", flush=True)
            return row[0]
        print(f"[runner] SKILL_ID={SKILL_ID!r} not found in DB", flush=True)
    except Exception as e:
        print(f"[runner] DB fetch failed ({type(e).__name__}): {e}", flush=True)
    return ""

# OpenClaw 模式：从 DB 读 Skill 内容，无大小限制；回退到 base64 env var（向后兼容）
SKILL_MD = _fetch_skill_md_from_db()
if not SKILL_MD and SKILL_MD_B64:
    SKILL_MD = base64.b64decode(SKILL_MD_B64).decode("utf-8")
    print(f"[runner] SKILL_MD fallback from env var: {len(SKILL_MD)} chars", flush=True)
CALLBACK_URL  = os.environ.get("CALLBACK_URL", "")      # 进度回调 URL（存入 DB 供前端实时展示）
SANDBOX_SECRET = os.environ.get("SANDBOX_SECRET", "")
MCP_CONFIGS   = os.environ.get("MCP_CONFIGS", "[]")      # JSON array: [{name, command, args}]
OAUTH_TOKENS  = os.environ.get("OAUTH_TOKENS", "")       # JSON: {provider/mcp_name: {access_token, ...}}
CASE_COUNT    = max(1, min(3, int(os.environ.get("CASE_COUNT", "1"))))  # 测试用例数（1-3）
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")                   # Tavily 搜索 API key
TICKET_MODE    = os.environ.get("TICKET_MODE", "0") == "1"              # 工单模式：跳过 Evaluator，返回 Executor 实际输出

# Fallback AI provider
FALLBACK_API_KEY  = os.environ.get("FALLBACK_AI_API_KEY", "")
FALLBACK_BASE_URL = os.environ.get("FALLBACK_AI_BASE_URL", "")
FALLBACK_MODEL    = os.environ.get("FALLBACK_AI_MODEL", "deepseek-chat")  # fallback 模型名，默认 deepseek-chat

# ─── SIGTERM 优雅退出（参照 OpenClaw AbortController 机制）────────────────────────
# Cloud Run 在硬杀前 10 秒发送 SIGTERM，我们捕获它实现优雅退出
_shutdown_requested: bool = False
_JOB_START_TIME: float = time.time()  # Job 启动时间
# 每个测试用例独立给予完整 600s（性能类似独立的 600s Cloud Run job）
PER_CASE_BUDGET: int = int(os.environ.get("PER_CASE_BUDGET_SECONDS", "580"))  # 每 case 最多用多少秒
EVALUATOR_BUDGET: int = 90   # Evaluator 保留时间
# 总 job timeout = CASE_COUNT × PER_CASE + Evaluator + 120s 启动开销
_JOB_TIMEOUT_SECONDS: int = int(os.environ.get(
    "JOB_TIMEOUT_SECONDS",
    str(CASE_COUNT * PER_CASE_BUDGET + EVALUATOR_BUDGET + 120)
))  # 默认按 CASE_COUNT 自动计算

def _sigterm_handler(sig, frame):
    global _shutdown_requested
    _shutdown_requested = True
    print("[runner] SIGTERM received, requesting graceful shutdown", flush=True)

signal.signal(signal.SIGTERM, _sigterm_handler)

def _job_elapsed() -> float:
    """Job 已运行秒数。"""
    return time.time() - _JOB_START_TIME

def _job_remaining() -> float:
    """剩余秒数，<=0 表示已超时。"""
    return _JOB_TIMEOUT_SECONDS - _job_elapsed()

# ─── 注入 OAuth tokens 到对应的 MCP 工具目录 ─────────────────────────────────
# 支持任意 MCP server，通过 mcp_name 匹配写入路径
# 写入格式以各 MCP server 要求的格式为准（不能只写 access_token）
MCP_TOKEN_PATHS = {
    # mcp_name → 写入路径（相对 home 目录）
    "stitch-mcp-auto": ".stitch-mcp-auto/tokens.json",
    "stitch":          ".stitch-mcp-auto/tokens.json",  # 别名
}

def _build_token_obj(raw: dict) -> dict:
    """把存储的 token 数据转成 MCP server 期望的完整格式"""
    import time
    obj = {
        "access_token":  raw.get("access_token", ""),
        "token_type":    raw.get("token_type", "Bearer"),
        "scope":         raw.get("scope", "https://www.googleapis.com/auth/cloud-platform"),
        # expiry_date 是 Google OAuth2 标准字段（unix ms），优先用存储值
        "expiry_date":   raw.get("expiry_date") or raw.get("expires_at") or (int(time.time() * 1000) + 3600_000),
    }
    if raw.get("refresh_token"):
        obj["refresh_token"] = raw["refresh_token"]
    return obj

# 明确打印 token 注入状态（不管有没有都打印，方便排查）
print(f"[oauth] OAUTH_TOKENS env present: {bool(OAUTH_TOKENS)}, len={len(OAUTH_TOKENS)}", flush=True)
if OAUTH_TOKENS:
    try:
        tokens_map = json.loads(OAUTH_TOKENS)
        print(f"[oauth] token keys: {list(tokens_map.keys())}", flush=True)
        home = os.path.expanduser("~")
        injected = False

        # 按 mcp_name 或 provider 匹配写入
        for key, rel_path in MCP_TOKEN_PATHS.items():
            if key in tokens_map:
                token_obj = _build_token_obj(tokens_map[key])
                full_path = os.path.join(home, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, "w") as f:
                    json.dump(token_obj, f, indent=2)
                print(f"[oauth] ✅ {key} token injected → {full_path}", flush=True)
                print(f"[oauth]   token_type={token_obj.get('token_type')} "
                      f"scope={token_obj.get('scope','')[:50]}... "
                      f"expiry={token_obj.get('expiry_date')}", flush=True)
                injected = True
                break  # 同一个 token 不重复写

        # 如果 tokens_map 里有 provider key 但没有匹配到 MCP_TOKEN_PATHS，
        # 说明是新 provider，也写一份通用的（以 provider 命名）
        if not injected:
            for provider, tdata in tokens_map.items():
                token_obj = _build_token_obj(tdata)
                generic_dir = os.path.join(home, f".mcp-oauth/{provider}")
                os.makedirs(generic_dir, exist_ok=True)
                generic_path = os.path.join(generic_dir, "tokens.json")
                with open(generic_path, "w") as f:
                    json.dump(token_obj, f, indent=2)
                print(f"[oauth] ✅ {provider} token → {generic_path} (generic fallback)", flush=True)
    except Exception as e:
        print(f"[oauth] ❌ token injection failed: {e}", flush=True)
else:
    print(f"[oauth] ⚠️  no OAUTH_TOKENS provided, MCP tools requiring auth may fail", flush=True)



# ─── 模型配置表（参照 OpenClaw model-context.ts）────────────────────────────
# context_window: 模型实际上下文窗口（tokens）
# max_output:     最大输出 tokens（影响 max_tokens 参数）
# max_input:      最大输入 tokens（实际可用输入空间）
# provider:       doubao / deepseek / openai
#
# 数据来源：各厂商 API 文档 + 截图里的模型详情页
_MODEL_CONFIGS: dict = {
    # ── Doubao Seed 系列（字节跳动）────────────────────────────────────────
    "doubao-seed-1-8-250715":       {"context_window": 256_000, "max_output": 96_000,  "max_input": 224_000, "provider": "doubao"},
    "doubao-seed-1-8-251228":       {"context_window": 256_000, "max_output": 96_000,  "max_input": 224_000, "provider": "doubao"},
    "doubao-seed-1-8":              {"context_window": 256_000, "max_output": 96_000,  "max_input": 224_000, "provider": "doubao"},
    "doubao-seed-1-6-250615":       {"context_window": 128_000, "max_output": 16_000,  "max_input": 112_000, "provider": "doubao"},
    "doubao-seed-1-6":              {"context_window": 128_000, "max_output": 16_000,  "max_input": 112_000, "provider": "doubao"},
    "doubao-pro-256k":              {"context_window": 256_000, "max_output": 4_096,   "max_input": 252_000, "provider": "doubao"},
    "doubao-pro-128k":              {"context_window": 128_000, "max_output": 4_096,   "max_input": 124_000, "provider": "doubao"},
    "doubao-pro-32k":               {"context_window": 32_000,  "max_output": 4_096,   "max_input": 28_000,  "provider": "doubao"},
    "doubao-lite-128k":             {"context_window": 128_000, "max_output": 4_096,   "max_input": 124_000, "provider": "doubao"},
    "doubao-lite-32k":              {"context_window": 32_000,  "max_output": 4_096,   "max_input": 28_000,  "provider": "doubao"},
    # ── DeepSeek 系列 ────────────────────────────────────────────────────
    "deepseek-chat":                {"context_window": 64_000,  "max_output": 8_192,   "max_input": 56_000,  "provider": "deepseek"},
    "deepseek-v4-flash":           {"context_window": 64_000,  "max_output": 8_192,   "max_input": 56_000,  "provider": "deepseek"},  # DeepSeek V4 Flash 0731
    "deepseek-coder":               {"context_window": 64_000,  "max_output": 8_192,   "max_input": 56_000,  "provider": "deepseek"},
    "deepseek-reasoner":            {"context_window": 64_000,  "max_output": 16_000,  "max_input": 56_000,  "provider": "deepseek"},
    # ── Gemini 系列 ─────────────────────────────────────────────────────────
    "gemini-2.0-flash":             {"context_window": 1_048_576, "max_output": 8_192, "max_input": 1_040_000, "provider": "google"},  # may be deprecated on v1beta/openai
    "gemini-2.5-flash":             {"context_window": 1_048_576, "max_output": 65_536, "max_input": 1_000_000, "provider": "google"},
    "gemini-2.5-flash-lite":        {"context_window": 1_048_576, "max_output": 65_536, "max_input": 1_000_000, "provider": "google"},
    "gemini-3.6-flash":             {"context_window": 1_048_576, "max_output": 65_536, "max_input": 1_000_000, "provider": "google"},
    "gemini-1.5-pro":               {"context_window": 2_097_152, "max_output": 8_192, "max_input": 2_090_000, "provider": "google"},
    "gemini-":                      {"context_window": 1_048_576, "max_output": 65_536, "max_input": 1_000_000, "provider": "google"},  # catch-all prefix for future Gemini models
    # ── 默认（未知模型）─────────────────────────────────────────────────────
    "_default":                     {"context_window": 128_000, "max_output": 4_096,   "max_input": 112_000, "provider": "unknown"},
}


def resolve_model_config(model: str = None) -> dict:
    """
    根据模型名称返回模型配置。
    优先级：
      1. 环境变量 CONTEXT_WINDOW_OVERRIDE（手动覆盖，用于测试或新模型）
      2. 精确匹配模型名
      3. 前缀模糊匹配（如 doubao-seed-1-8-xxx → doubao-seed-1-8）
      4. 默认值 128k
    """
    model = (model or AI_MODEL or "").strip().lower()

    # 1. 环境变量强制覆盖
    override = os.environ.get("CONTEXT_WINDOW_OVERRIDE", "")
    if override:
        try:
            ctx = int(override)
            return {**_MODEL_CONFIGS["_default"], "context_window": ctx,
                    "max_input": int(ctx * 0.875), "source": "env_override"}
        except ValueError:
            pass

    # 2. 精确匹配
    if model in _MODEL_CONFIGS:
        return {**_MODEL_CONFIGS[model], "source": "exact_match", "model": model}

    # 3. 前缀匹配（从最长 key 开始）
    sorted_keys = sorted(_MODEL_CONFIGS.keys(), key=len, reverse=True)
    for key in sorted_keys:
        if key != "_default" and model.startswith(key):
            return {**_MODEL_CONFIGS[key], "source": "prefix_match", "model": model, "matched_key": key}

    # 4. 从名称猜测（doubao-xxx-256k 这种带 context size 的命名）
    import re
    m = re.search(r'(\d+)k', model)
    if m:
        ctx = int(m.group(1)) * 1000
        if 8_000 <= ctx <= 2_000_000:
            return {**_MODEL_CONFIGS["_default"], "context_window": ctx,
                    "max_input": int(ctx * 0.875), "source": "name_infer", "model": model}

    # 5. 默认
    cfg = _MODEL_CONFIGS["_default"].copy()
    cfg["source"] = "default"
    cfg["model"] = model
    return cfg


# 在模块加载时解析并缓存当前模型配置
_CURRENT_MODEL_CONFIG = resolve_model_config(AI_MODEL)
CONTEXT_WINDOW_TOKENS = _CURRENT_MODEL_CONFIG["context_window"]
MAX_OUTPUT_TOKENS     = min(_CURRENT_MODEL_CONFIG["max_output"], 32_000)  # Gemini 支持 65k，豆包/DS 实际 16k
print(f"[config] model={AI_MODEL!r} → context={CONTEXT_WINDOW_TOKENS//1000}k tokens "
      f"max_output={MAX_OUTPUT_TOKENS} source={_CURRENT_MODEL_CONFIG['source']}", flush=True)


# 设置 mcporter 内部超时（默认 60s 太短，npx 首次下载包 + MCP server 启动可能超 60s）
os.environ.setdefault("MCPORTER_CALL_TIMEOUT", "180000")  # 180 秒（毫秒）
print(f"[config] MCPORTER_CALL_TIMEOUT={os.environ['MCPORTER_CALL_TIMEOUT']}ms", flush=True)

def auto_configure_mcp():
    """沙箱启动时自动配置已保存的 MCP 服务。
    直接写 mcporter.json 而不是用 `mcporter config add`，
    因为后者把 --args 的值合成单个字符串（如 ["-y pkg"]），
    但 npx 需要分开的参数（如 ["-y", "pkg"]）。
    """
    try:
        configs = json.loads(MCP_CONFIGS)
        if not configs:
            return
        mcp_servers = {}
        for cfg in configs:
            name = cfg.get("name", "")
            cmd = cfg.get("command", "").strip('"').strip("'")
            args = cfg.get("args", "")
            if not name or not cmd:
                continue
            # 把 args 字符串拆成数组（如 "-y stitch-mcp-auto" → ["-y", "stitch-mcp-auto"]）
            if isinstance(args, str) and args.strip():
                import shlex
                args_list = shlex.split(args)
            elif isinstance(args, list):
                args_list = args
            else:
                args_list = []
            mcp_servers[name] = {"command": cmd, "args": args_list}
            print(f"[MCP] 已配置: {name} (command={cmd} args={args_list})", flush=True)

        if mcp_servers:
            config_dir = os.path.join(os.path.expanduser("~"), "config")
            os.makedirs(config_dir, exist_ok=True)
            config_path = os.path.join(config_dir, "mcporter.json")
            with open(config_path, "w") as f:
                json.dump({"mcpServers": mcp_servers}, f, indent=2)
            print(f"[MCP] 写入 {config_path}（{len(mcp_servers)} 个服务）", flush=True)
    except Exception as e:
        print(f"[MCP] 解析 MCP_CONFIGS 失败: {e}", flush=True)


# ─── MCP 工具动态发现（OpenClaw 风格：把 MCP tools 注册为 native function calling）──
# 启动时 mcporter list --schema --json，把 MCP server 的工具注入 TOOLS 数组，
# AI 直接用 function calling 调用，不需要记 mcporter CLI 语法
_MCP_TOOL_REGISTRY: dict = {}  # { "server__tool": {"server": str, "tool": str, "schema": dict} }

def discover_mcp_tools() -> list:
    """运行 mcporter list --schema --json，解析工具列表，注册为 native tools。
    返回新增的 TOOLS 条目列表。"""
    # 如果 MCP_CONFIGS 为空数组，跳过 discover（省 60s timeout）
    try:
        if not json.loads(MCP_CONFIGS):
            return []
    except Exception:
        return []
    try:
        result = subprocess.run(
            "mcporter list --schema --json",
            shell=True, capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0 or not result.stdout.strip():
            print(f"[MCP-discover] mcporter list failed: {result.stderr[:200]}", flush=True)
            return []
        data = json.loads(result.stdout)
        servers = data.get("servers", [])
        new_tools = []
        for srv in servers:
            srv_name = srv.get("name", "")
            status = srv.get("status", "")
            if status != "ok":
                print(f"[MCP-discover] skip {srv_name}: status={status}", flush=True)
                continue
            for tool in srv.get("tools", []):
                tool_name = tool.get("name", "")
                if not tool_name:
                    continue
                # 用 server__tool 作为 function name（避免冲突）
                fn_name = f"mcp__{srv_name}__{tool_name}"
                desc = tool.get("description", f"MCP tool {srv_name}.{tool_name}")
                # 取 input schema（若有），否则用通用 kwargs schema
                input_schema = tool.get("inputSchema") or {
                    "type": "object",
                    "properties": {
                        "args": {
                            "type": "string",
                            "description": "Tool arguments in 'key=value key2=value2' format"
                        }
                    },
                    "required": []
                }
                _MCP_TOOL_REGISTRY[fn_name] = {
                    "server": srv_name,
                    "tool": tool_name,
                    "schema": input_schema,
                }
                new_tools.append({
                    "type": "function",
                    "function": {
                        "name": fn_name,
                        "description": f"[MCP: {srv_name}] {desc}",
                        "parameters": input_schema,
                    }
                })
                print(f"[MCP-discover] registered: {fn_name}", flush=True)
        return new_tools
    except Exception as e:
        print(f"[MCP-discover] error: {e}", flush=True)
        return []


def tool_mcp_call(fn_name: str, args: dict) -> dict:
    """
    执行 MCP tool call。
    支持两种 AI 传参格式：
    1. 结构化对象（优先）：{"url": "https://..."} → mcporter call server.tool url='https://...'
    2. 通用字符串（schema fallback）：{"args": "url=https://..."} → 直接拼接
    """
    reg = _MCP_TOOL_REGISTRY.get(fn_name)
    if not reg:
        return {"error": f"MCP tool not registered: {fn_name}"}
    server = reg["server"]
    tool = reg["tool"]

    # 情况1：AI 用了通用 schema，传了 {"args": "url=..."} 字符串格式
    if set(args.keys()) == {"args"} and isinstance(args.get("args"), str):
        args_str = args["args"]
    else:
        # 情况2：AI 用了正确的结构化参数，转成 key=value 格式
        arg_parts = []
        for k, v in args.items():
            if isinstance(v, str):
                # url 等字符串值用单引号，避免 shell 展开
                escaped = v.replace("'", "'\"'\"'")
                arg_parts.append(f"{k}='{escaped}'")
            elif isinstance(v, (dict, list)):
                arg_parts.append(f"{k}='{json.dumps(v)}'")
            else:
                arg_parts.append(f"{k}={v}")
        args_str = " ".join(arg_parts)

    cmd = f"mcporter call {server}.{tool} {args_str}".strip()
    print(f"[MCP-call] {cmd[:160]}", flush=True)
    effective = _effective_timeout(cmd, 60)
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=effective
        )
        out = r.stdout[-4000:] if len(r.stdout) > 4000 else r.stdout
        err = r.stderr[-1000:] if len(r.stderr) > 1000 else r.stderr
        return {"stdout": out, "stderr": err, "exit_code": r.returncode}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"timeout after {effective}s", "exit_code": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -2}



# ─── OpenClaw exec-auto-reviewer（简化版）──────────────────────────────────────
# 参考 OpenClaw exec-auto-reviewer.prompt.ts：拦截无效命令，节省 AI 轮次
PRE_INSTALLED_PKGS = {
    'requests', 'httpx', 'pypdf2', 'pdfplumber', 'python-docx', 'python-pptx',
    'pillow', 'pytesseract', 'pandas', 'numpy', 'openai', 'flask', 'fastapi'
}

def exec_pre_review(command: str) -> str | None:
    """
    返回 None = 允许执行；返回 str = 拦截并把提示返回给 AI。
    参考 OpenClaw DEFAULT_EXEC_REVIEWER_SYSTEM_PROMPT 的审查逻辑。
    """
    cmd = command.strip().lower()

    # 拦截：创建虚拟环境（所有包已全局预装，venv 会丢失它们）
    if 'python3 -m venv' in cmd or 'python -m venv' in cmd or 'virtualenv ' in cmd:
        return (
            "⛔ 已拦截：不允许创建虚拟环境。\n"
            "所有所需包已在系统 Python 里预装，直接用 python3 即可。\n"
            "已预装：requests, httpx, PyPDF2, pdfplumber, python-docx, python-pptx, "
            "Pillow, pytesseract, pandas, numpy, openai"
        )

    # 拦截：安装已预装的包
    if ('pip install' in cmd or 'pip3 install' in cmd) and 'venv' not in cmd:
        blocked = [p for p in PRE_INSTALLED_PKGS if p in cmd]
        if blocked:
            return (
                f"⛔ 已拦截：{', '.join(blocked)} 已预装，无需重新安装。\n"
                "如需其他包可以安装，但以上包直接 import 即可。"
            )

    # 允许执行
    return None

# ─── 工具：bash exec ──────────────────────────────────────────────────────────
# MCP / npx 命令需要更长超时（首次 npx 要下载 npm 包，可能 60-120s）
_MCP_CMD_PATTERNS = ['mcporter call', 'mcporter ', 'npx ', 'npx -y ']
_MCP_TIMEOUT = 180  # 3 分钟，足够首次 npx 下载

def _effective_timeout(command: str, requested: int) -> int:
    """智能调整超时：MCP/npx 命令至少给 _MCP_TIMEOUT 秒"""
    cmd_lower = command.strip().lower()
    for pat in _MCP_CMD_PATTERNS:
        if pat in cmd_lower:
            return max(requested, _MCP_TIMEOUT)
    return requested

def tool_exec(command: str, workdir: str = "/home/sandbox", timeout: int = 60) -> dict:
    # OpenClaw exec-auto-reviewer 拦截
    review = exec_pre_review(command)
    if review:
        print(f"[exec-blocked] {command[:80]}", flush=True)
        return {"stdout": review, "stderr": "", "exit_code": 0, "_blocked": True}

    # ── 拦截 mcporter config add：修正 args 分割问题 ──
    # mcporter config add 的 --args 把多个参数合成一个字符串，导致 npx 收到错误参数
    # 我们直接写 mcporter.json，确保 args 被正确拆分为数组
    mcp_match = re.match(
        r"mcporter\s+config\s+add\s+(\S+)\s+--command\s+['\"]?(\S+?)['\"]?"
        r"(?:\s+--args\s+['\"](.+?)['\"])?\s*$",
        command.strip()
    )
    if mcp_match:
        name, cmd, args_str = mcp_match.groups()
        cmd = cmd.strip("'\"")
        import shlex
        args_list = shlex.split(args_str) if args_str else []
        config_path = os.path.join(os.path.expanduser("~"), "config", "mcporter.json")
        # 读取现有配置并合并
        existing = {}
        if os.path.exists(config_path):
            with open(config_path) as f:
                existing = json.load(f).get("mcpServers", {})
        existing[name] = {"command": cmd, "args": args_list}
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(config_path, "w") as f:
            json.dump({"mcpServers": existing}, f, indent=2)
        msg = f"Added '{name}' to {config_path}\n"
        print(f"[exec] mcporter config add intercepted: {name} (cmd={cmd} args={args_list})", flush=True)
        return {"stdout": msg, "stderr": "", "exit_code": 0}

    # 智能超时：MCP 命令自动加长
    effective = _effective_timeout(command, timeout)
    if effective != timeout:
        print(f"[exec] $ {command[:120]}  (timeout: {timeout}→{effective}s, MCP auto-extend)", flush=True)
    else:
        print(f"[exec] $ {command[:120]}", flush=True)
    try:
        result = subprocess.run(
            command, shell=True, cwd=workdir,
            capture_output=True, text=True, timeout=effective,
        )
        out = result.stdout[-3000:] if len(result.stdout) > 3000 else result.stdout
        err = result.stderr[-1000:] if len(result.stderr) > 1000 else result.stderr
        return {"stdout": out, "stderr": err, "exit_code": result.returncode}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"timeout after {effective}s", "exit_code": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -2}

# ─── 工具：write file ─────────────────────────────────────────────────────────
def tool_write(path: str, content: str) -> dict:
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ─── 工具：read file ──────────────────────────────────────────────────────────
def tool_read(path: str) -> dict:
    try:
        with open(path) as f:
            return {"ok": True, "content": f.read()[:5000]}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ─── 工具：web_search（Tavily 搜索，参照 OpenClaw web_search tool）─────────────
def tool_web_search(query: str, max_results: int = 5) -> dict:
    """
    调用 Tavily Search API 执行真实网络搜索。
    返回带真实 URL 的搜索结果，AI 可进一步用 mcp__fetch__* 抓取全文。
    参照 OpenClaw web_search 工具的定位：先搜 → 得真实 URL → 再抓内容。
    """
    import requests as _req
    if not TAVILY_API_KEY:
        return {"error": "TAVILY_API_KEY not configured", "results": []}
    try:
        resp = _req.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "max_results": max(1, min(10, max_results)),
                "search_depth": "basic",
                "include_answer": False,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        results = [
            {
                "url":     r.get("url", ""),
                "title":   r.get("title", ""),
                "content": r.get("content", "")[:600],
                "score":   round(r.get("score", 0), 3),
            }
            for r in data.get("results", [])
        ]
        print(f"[web_search] query={query!r} → {len(results)} results", flush=True)
        return {"results": results}
    except Exception as e:
        print(f"[web_search] error: {e}", flush=True)
        return {"error": str(e), "results": []}


# ─── 工具：invoke_skill（子 Agent 调用）──────────────────────────────────────
def tool_invoke_skill(user_message: str, skill_system_prompt: str = None) -> dict:
    """
    以 Skill 身份回答一条用户消息。
    类似 OpenClaw promptTemplate 注入——AI 就是那个 Skill 在运行。
    用于测试 prompt-only Skill：不需要写代码，直接 AI-to-AI 调用。
    """
    system = skill_system_prompt or SKILL_MD
    if not system:
        return {"ok": False, "error": "SKILL_MD 为空，无法调用 Skill"}
    print(f"[invoke_skill] user_message={user_message[:80]!r}", flush=True)
    try:
        resp = _do_ai_call(
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": user_message},
            ],
            tools=None,
            first_token_timeout=120,
        )
        choice = resp.get("choices", [{}])[0]
        reply = choice.get("message", {}).get("content", "")
        usage = resp.get("usage", {})
        print(f"[invoke_skill] reply={reply[:120]!r} tokens={usage}", flush=True)
        return {"ok": True, "response": reply, "usage": usage}
    except Exception as e:
        print(f"[invoke_skill] error: {e}", flush=True)
        return {"ok": False, "error": str(e)}

# ─── 进度上报（stdout + HTTP POST 到平台，线程异步不阻塞主流程）──────────────
def _post_progress(msg: dict):
    if not CALLBACK_URL:
        return
    import threading
    def _send():
        try:
            import urllib.request as _ur
            data = json.dumps({"type": "progress", "event": msg, "secret": SANDBOX_SECRET}).encode()
            req = _ur.Request(CALLBACK_URL, data=data,
                              headers={"Content-Type": "application/json"}, method="POST")
            _ur.urlopen(req, timeout=5)
        except Exception:
            pass  # 进度上报失败不影响主流程
    threading.Thread(target=_send, daemon=True).start()

def progress(step: str, detail: str = ""):
    ts = datetime.now(timezone.utc).isoformat()
    msg = {"ts": ts, "step": step, "detail": detail}
    print(f"[PROGRESS] {json.dumps(msg, ensure_ascii=False)}", flush=True)
    _post_progress(msg)  # 同时 POST 到平台存入 DB

# ─── 工具定义（传给 AI 的 tool_choice 格式）──────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "exec",
            "description": "在沙箱 Linux 环境里执行 bash 命令。可用于安装依赖(pip/npm)、运行脚本、处理文件。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的 bash 命令"},
                    "timeout": {"type": "integer", "description": "超时秒数，默认60", "default": 60}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "写文件到沙箱文件系统",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取沙箱文件系统中的文件内容",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "使用 Tavily 搜索引擎搜索网络，返回真实 URL 和内容摘要。"
                " 参照 OpenClaw web_search 工具：先用此工具搜索获得真实 URL，"
                " 再用 mcp__fetch__fetch_readable 抓取全文。"
                " 禁止直接猜测或编造文章 URL，必须先搜索。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词（英文效果更好）"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "最多返回几条结果（1-10，默认5）",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "invoke_skill",
            "description": (
                "向当前 Skill 发送一条用户消息，返回 Skill 的回复。"
                " Skill 的 system prompt（SKILL.md 全文）已自动加载，只需传 user_message。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "user_message": {
                        "type": "string",
                        "description": "发给 Skill 的用户消息（即一条测试用例的内容）"
                    }
                },
                "required": ["user_message"]
            }
        }
    },
]


# ─── OpenClaw 风格上下文压缩（参照 pruner.ts pruneContextMessages）───────────
# 阈值参照 OpenClaw EffectiveContextPruningSettings
KEEP_LAST_ASSISTANTS = 3     # 保留最近3个 assistant 消息（及其 tool results）
SOFT_TRIM_RATIO = 0.6        # context 占比 > 60% 开始 soft trim
HARD_CLEAR_RATIO = 0.85      # context 占比 > 85% 做 hard clear
SOFT_TRIM_HEAD  = 1500       # soft trim: 保留头部字符数
SOFT_TRIM_TAIL  = 1500       # soft trim: 保留尾部字符数
SOFT_TRIM_MAX   = 4000       # soft trim 触发阈值
MIN_PRUNABLE_TOOL_CHARS = 1000  # 可裁剪 tool 至少这么大才值得处理
HARD_CLEAR_PLACEHOLDER = "[tool output cleared to save context space]"
CHARS_PER_TOKEN = 4          # 粗略换算

# 不可裁剪的工具（系统关键输出）
NON_PRUNABLE_TOOLS = {"write_file"}


def estimate_chars(messages: list) -> int:
    """
    参照 OpenClaw estimateContextChars：
    估算消息数组的总字符数（包括 content + tool_calls arguments）
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    total += len(block["text"])
        # tool_calls arguments
        for tc in msg.get("tool_calls", []):
            fn = tc.get("function", {})
            total += len(fn.get("arguments", ""))
    return total


def _find_assistant_cutoff(messages: list, keep_last: int) -> int:
    """
    参照 OpenClaw findAssistantCutoffIndex：
    找到从哪个 index 开始之后的 assistant 消息需要保留。
    """
    assistant_indices = [i for i, m in enumerate(messages) if m.get("role") == "assistant"]
    if len(assistant_indices) <= keep_last:
        return 0  # 不够 keep_last 个，全部保留
    return assistant_indices[-keep_last]


def _find_first_user_index(messages: list) -> int:
    """
    参照 OpenClaw findFirstUserIndex：
    Bootstrap 保护——不裁剪第一个 user message 之前的内容。
    保护 system prompt + identity 读取。
    """
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            return i
    return len(messages)


def prune_context(messages: list, context_window_tokens: int = None) -> list:
    context_window_tokens = context_window_tokens or CONTEXT_WINDOW_TOKENS
    """
    参照 OpenClaw pruneContextMessages (412 行)：
    
    三阶段裁剪策略：
    1. 检测 ratio（context 占比）→ < softTrimRatio 不裁剪
    2. Soft trim：对 cutoff 之前的 tool results 做 head+tail 裁剪
    3. Hard clear：如果 soft trim 后 ratio 还是 > hardClearRatio，
       完全清空最旧的 tool results
    
    保护规则：
    - Bootstrap：不裁剪第一个 user message 之前的内容
    - 保留最近 KEEP_LAST_ASSISTANTS 个 assistant 及其 tool results
    - write_file 等关键工具不裁剪
    """
    char_window = context_window_tokens * CHARS_PER_TOKEN
    if char_window <= 0:
        return messages

    # 找到 cutoff index
    cutoff_idx = _find_assistant_cutoff(messages, KEEP_LAST_ASSISTANTS)
    if cutoff_idx == 0:
        return messages

    # Bootstrap 保护
    first_user_idx = _find_first_user_index(messages)
    prune_start = max(1, first_user_idx)  # 至少保留 system prompt (index 0)

    # 检测 ratio
    total_chars = estimate_chars(messages)
    ratio = total_chars / char_window
    if ratio < SOFT_TRIM_RATIO:
        return messages

    # ─── Phase 1: Soft trim ───────────────────────────────────────────────
    result = list(messages)
    prunable_tool_indices = []

    for i in range(prune_start, cutoff_idx):
        msg = result[i]
        if msg.get("role") != "tool":
            continue

        # 检查是否可裁剪（有些工具不能裁剪）
        # 尝试从 tool_calls 匹配 tool name
        tool_name = _resolve_tool_name(messages, msg.get("tool_call_id", ""))
        if tool_name in NON_PRUNABLE_TOOLS:
            continue

        prunable_tool_indices.append(i)

        content = msg.get("content", "")
        if not isinstance(content, str) or len(content) <= SOFT_TRIM_MAX:
            continue

        # Soft trim: 使用 truncation 模块的智能截断
        from truncation import truncate_tool_result
        trimmed = truncate_tool_result(content, SOFT_TRIM_MAX, min_keep=SOFT_TRIM_HEAD)
        before_chars = len(content)
        after_chars = len(trimmed)
        total_chars += (after_chars - before_chars)
        result[i] = {**msg, "content": trimmed}

    # ─── Phase 2: 检查 soft trim 后的 ratio ──────────────────────────────
    ratio = total_chars / char_window
    if ratio < HARD_CLEAR_RATIO:
        return result

    # ─── Phase 3: Hard clear ──────────────────────────────────────────────
    # 检查可裁剪的 tool chars 是否足够值得 hard clear
    prunable_chars = sum(
        len(result[i].get("content", ""))
        for i in prunable_tool_indices
        if isinstance(result[i].get("content"), str)
    )
    if prunable_chars < MIN_PRUNABLE_TOOL_CHARS:
        return result

    for i in prunable_tool_indices:
        if ratio < HARD_CLEAR_RATIO:
            break
        msg = result[i]
        content = msg.get("content", "")
        if not isinstance(content, str):
            continue

        before_chars = len(content)
        result[i] = {**msg, "content": HARD_CLEAR_PLACEHOLDER}
        after_chars = len(HARD_CLEAR_PLACEHOLDER)
        total_chars += (after_chars - before_chars)
        ratio = total_chars / char_window

    return result


def _resolve_tool_name(messages: list, tool_call_id: str) -> str:
    """从 assistant 消息的 tool_calls 反查工具名称"""
    if not tool_call_id:
        return ""
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        for tc in msg.get("tool_calls", []):
            if tc.get("id") == tool_call_id:
                return tc.get("function", {}).get("name", "")
    return ""


# ─── AI 调用（OpenAI 兼容接口，仿 OpenClaw FailoverError 多 provider）───────
def _parse_sse_stream(r) -> dict:
    """
    解析 OpenAI-compatible SSE 流，合并 delta → 标准 chat.completions 响应格式。
    参照 OpenClaw openai-transport-stream.ts 的 chunk 合并逻辑。
    每次 readline() 只等一个 chunk（毫秒级），彻底解决 read timeout 问题。
    """
    choices: dict = {}   # index → {role, content, tool_calls[]}
    usage: dict = {}
    model_out = ""
    finish_reason = None

    for raw_line in r:
        line = raw_line.decode("utf-8", errors="replace").rstrip()
        if not line:
            continue
        if line.startswith("data: "):
            payload = line[6:].strip()
        elif line.startswith("data:"):
            payload = line[5:].strip()
        else:
            continue
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        # ── 检测 SSE 流内嵌的错误（Doubao 偶发：空响应、工具调用失败等）──────
        if "error" in chunk:
            err = chunk["error"]
            err_msg = err.get("message") or str(err)
            raise RuntimeError(f"AI stream error: {err_msg}")

        if chunk.get("model"):
            model_out = chunk["model"]
        if chunk.get("usage"):
            usage = chunk["usage"]

        for ch in chunk.get("choices", []):
            idx = ch.get("index", 0)
            c = choices.setdefault(idx, {
                "index": idx,
                "message": {"role": "assistant", "content": ""},
                "finish_reason": None,
            })
            if ch.get("finish_reason"):
                c["finish_reason"] = ch["finish_reason"]
                finish_reason = ch["finish_reason"]
            delta = ch.get("delta", {})
            # ── content delta ──────────────────────────────────────────
            if delta.get("content"):
                c["message"]["content"] += delta["content"]
            if delta.get("role"):
                c["message"]["role"] = delta["role"]
            # ── Gemini thinking delta ────────────────────────────────────
            # Gemini thinking models stream thinking tokens via delta.thinking
            thinking_delta = delta.get("thinking") or delta.get("thinking_content") or ""
            if thinking_delta:
                c["message"]["_thinking"] = c["message"].get("_thinking", "") + thinking_delta
            # ── tool_calls delta (OpenAI 风格) ─────────────────────────
            for tc_delta in delta.get("tool_calls", []):
                tc_idx  = tc_delta.get("index", 0)
                tc_list = c["message"].setdefault("tool_calls", [])
                while len(tc_list) <= tc_idx:
                    tc_list.append({"id": "", "type": "function",
                                    "function": {"name": "", "arguments": ""}})
                tc = tc_list[tc_idx]
                if tc_delta.get("id"):
                    tc["id"] = tc_delta["id"]
                if tc_delta.get("type"):
                    tc["type"] = tc_delta["type"]
                fn_delta = tc_delta.get("function", {})
                if fn_delta.get("name"):
                    tc["function"]["name"] += fn_delta["name"]
                if fn_delta.get("arguments"):
                    tc["function"]["arguments"] += fn_delta["arguments"]
                # ── Gemini 3.6 Flash: 保留 extra_content（含 thought_signature）────
                # 发送 tool result 时 assistant 消息必须原样带回 thought_signature，
                # 否则 Gemini 报 400 "Function call is missing a thought"
                if tc_delta.get("extra_content"):
                    tc["extra_content"] = tc_delta["extra_content"]


    # tool_calls 为空时删掉 key（和非流式格式保持一致）
    for c in choices.values():
        if not c["message"].get("tool_calls"):
            c["message"].pop("tool_calls", None)

    return {
        "choices": list(choices.values()),
        "model": model_out,
        "usage": usage,
    }


def _do_ai_call(messages: list, tools=None, first_token_timeout=120,
                api_key: str = None, base_url: str = None, model: str = None) -> dict:
    """
    流式 SSE AI 调用（参照 OpenClaw stream:true + firstEventTimeoutMs 模式）。
    - first_token_timeout: 仅控制「连接建立 + 首个 token 到达」的超时（秒）
    - 之后每行 readline() 自动继承 socket timeout，每 chunk 毫秒级，不会 read-timeout
    - 彻底解决 urllib r.read() 等整个响应体导致的超时问题
    """
    import urllib.request, urllib.error, socket
    key       = api_key  or AI_API_KEY
    base      = base_url or AI_BASE_URL
    use_model = model    or AI_MODEL
    body = {
        "model":      use_model,
        "messages":   messages,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream":     True,          # ← 关键：永远流式，参照 OpenClaw
    }
    if tools:
        body["tools"]       = tools
        body["tool_choice"] = "auto"
    # 注意：Gemini OpenAI 兼容端点不支持 'thinking' 字段（仅原生 Gemini API 支持）
    # 不传该字段，模型自身内部会对应处理

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=data,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    # 网络瞬时错误（SSL EOF、ConnectionReset）自动重试 2 次
    last_err = None
    for attempt in range(3):
        try:
            # first_token_timeout 只控制首 token；之后 readline 每行几十 ms 不超时
            with urllib.request.urlopen(req, timeout=first_token_timeout) as r:
                # 收到首个 data 行后放宽 socket timeout，让后续慢慢生成
                try:
                    r.fp.raw._sock.settimeout(120)   # 每个 chunk 间隔最多 120s（Gemini thinking 模型生成慢）
                except Exception:
                    pass
                return _parse_sse_stream(r)
        except urllib.error.HTTPError as e:
            body_str = e.read().decode(errors="replace")
            raise RuntimeError(f"AI API error {e.code}: {body_str}")
        except (urllib.error.URLError, socket.error, OSError) as e:
            last_err = e
            err_str = str(e)
            # SSL EOF / ConnectionReset / timeout → 可重试
            if attempt < 2 and ('EOF' in err_str or 'ssl' in err_str.lower()
                                or 'reset' in err_str.lower() or 'ConnectionReset' in err_str):
                import time
                wait = (attempt + 1) * 2  # 2s, 4s
                print(f"[_do_ai_call] transient error (attempt {attempt+1}/3): {err_str[:80]}, retry in {wait}s", flush=True)
                time.sleep(wait)
                # 重建 Request（urllib.request.Request 被消费后不可重用）
                req = urllib.request.Request(
                    f"{base}/chat/completions",
                    data=data,
                    headers={"Authorization": f"Bearer {key}",
                             "Content-Type": "application/json"},
                    method="POST",
                )
                continue
            raise RuntimeError(f"AI API connection error: {err_str}") from e
    raise RuntimeError(f"AI API failed after 3 attempts: {last_err}")


def call_ai(messages: list, tools=None) -> dict:
    """
    3-level fallback (OpenClaw FailoverError pattern):
    Level 1: Primary provider + tools  (streaming)
    Level 2: Fallback provider + tools (FALLBACK_MODEL，修复模型名问题)
    Level 3: Primary provider, no tools, simplified context
    """
    try:
        return _do_ai_call(messages, tools)
    except (RuntimeError, Exception) as e1:
        err1 = str(e1)
        print(f"[call_ai] L1 failed: {err1[:100]}", flush=True)

        # Level 2: fallback provider + 正确的 fallback 模型名
        if FALLBACK_API_KEY and FALLBACK_BASE_URL:
            try:
                print(f"[call_ai] L2 trying fallback ({FALLBACK_MODEL})...", flush=True)
                return _do_ai_call(messages, tools,
                                   api_key=FALLBACK_API_KEY,
                                   base_url=FALLBACK_BASE_URL,
                                   model=FALLBACK_MODEL)
            except Exception as e2:
                print(f"[call_ai] L2 failed: {str(e2)[:80]}", flush=True)

        # Level 3: no tools + simplified context
        if "tool" in err1.lower() or "output" in err1.lower() or "empty" in err1.lower():
            print("[call_ai] L3 retry: no tools, simplified context", flush=True)
            sys_msg = [m for m in messages if m.get("role") == "system"]
            usr_msg = [m for m in messages if m.get("role") == "user"]
            simple  = sys_msg + (usr_msg[-1:] if usr_msg else [])
            simple.append({"role": "user", "content": "Please output the final test result as JSON only."})
            return _do_ai_call(simple, tools=None)
        raise

# ─── 工具调用分发 ─────────────────────────────────────────────────────────────
def dispatch_tool(name: str, args: dict) -> str:
    if name == "exec":
        r = tool_exec(args["command"], timeout=args.get("timeout", 60))
        return json.dumps(r, ensure_ascii=False)
    elif name == "write_file":
        r = tool_write(args["path"], args["content"])
        return json.dumps(r, ensure_ascii=False)
    elif name == "read_file":
        r = tool_read(args["path"])
        return json.dumps(r, ensure_ascii=False)
    elif name == "invoke_skill":
        r = tool_invoke_skill(
            user_message=args["user_message"],
            skill_system_prompt=args.get("skill_system_prompt"),
        )
        return json.dumps(r, ensure_ascii=False)
    elif name == "web_search":
        r = tool_web_search(
            query=args["query"],
            max_results=args.get("max_results", 5),
        )
        return json.dumps(r, ensure_ascii=False)
    elif name in _MCP_TOOL_REGISTRY:
        r = tool_mcp_call(name, args)
        return json.dumps(r, ensure_ascii=False)
    return json.dumps({"error": f"unknown tool: {name}"})


# ─── Skill 类型检测 ──────────────────────────────────────────────────────────
def detect_skill_type(skill_md: str) -> str:
    """
    根据 SKILL.md 内容判断 Skill 类型：
    - 'mcp'    : requires mcporter → Executor 有 MCP native tools
    - 'script' : 有 bash 脚本 → Executor 有 exec 工具
    - 'prompt' : 纯提示词 → 用 invoke_skill（内层 AI 无工具，正确行为）
    """
    md_lower = skill_md.lower()
    if "mcporter" in md_lower or ('"mcporter"' in skill_md) or ("'mcporter'" in skill_md):
        return "mcp"
    if "scripts/" in skill_md or "```bash" in skill_md or "```sh" in skill_md:
        return "script"
    return "prompt"


# ─── Executor Agent（双 Agent 架构核心）────────────────────────────────────────
# 参照 OpenClaw 设计：Executor 以 SKILL.md 为 system prompt，有真实工具，
# 独立执行 Skill 功能，与评测 AI 完全分离。
EXECUTOR_TOOLS = None  # 在 main() 里动态构建（含 MCP native tools）

# OpenClaw 移植说明：没有 submit_result 工具。
# AI 收集完信息后自然输出文字（end_turn），即为任务完成。
# 参照 OpenClaw attempt.ts：stopReason = "end_turn" → 直接返回结果。

# ─── OpenClaw Preemptive Compaction（参照 preemptive-compaction.ts）───────────
# 常量来自 OpenClaw 源码
_OC_CHARS_PER_TOKEN = 4        # 普通文字
_OC_TOOL_CHARS_PER_TOKEN = 2   # tool result 更保守（JSON 密度高）
_OC_MSG_OVERHEAD_TOKENS = 12   # 每条消息固定开销
_OC_SAFETY_MARGIN = 1.1        # 估算安全系数，避免低估
_OC_MIN_PROMPT_BUDGET_RATIO = 0.5   # 保留至少 50% context 给 prompt

def _oc_estimate_tokens(messages: list, system: str, context_window: int) -> dict:
    """
    参照 OpenClaw estimateLlmBoundaryTokenPressure。
    估算当前 context 占用，返回 {estimated, budget, overflow, tool_reducible}。
    """
    total_chars = len(system)
    tool_chars = 0
    for m in messages:
        content = m.get("content") or ""
        if isinstance(content, list):
            content = " ".join(str(b) for b in content)
        total_chars += len(content) + _OC_MSG_OVERHEAD_TOKENS * _OC_CHARS_PER_TOKEN
        if m.get("role") == "tool":
            tool_chars += len(content)

    estimated = int(total_chars / _OC_CHARS_PER_TOKEN * _OC_SAFETY_MARGIN)
    reserve = max(8000, int(context_window * (1 - _OC_MIN_PROMPT_BUDGET_RATIO)))
    budget = context_window - reserve
    overflow = max(0, estimated - budget)
    # tool result 可压缩量（保守估算：tool result 平均可缩 70%）
    tool_reducible = int(tool_chars * 0.7 / _OC_TOOL_CHARS_PER_TOKEN)
    return {
        "estimated": estimated,
        "budget": budget,
        "overflow": overflow,
        "tool_reducible_tokens": tool_reducible,
        "pressure_pct": int(estimated / max(1, context_window) * 100),
    }

def _oc_compact_route(pressure: dict) -> str:
    """
    参照 OpenClaw shouldPreemptivelyCompactBeforePrompt。
    返回路由：fits / truncate / compact（暂不实现 LLM 摘要，只截短）。
    """
    overflow = pressure["overflow"]
    if overflow <= 0:
        return "fits"
    # tool result 可缩减量 >= overflow * 1.5 → 只截短（truncate_tool_results_only）
    if pressure["tool_reducible_tokens"] >= overflow * 1.5:
        return "truncate"
    return "compact"  # 暂与 truncate 同处理（不做 LLM 摘要压缩）

def _oc_truncate_tool_results(messages: list, keep_recent: int = 3,
                               max_chars: int = 2000) -> list:
    """
    参照 OpenClaw truncate_tool_results_only 路由。
    截短旧 tool result，保留最近 keep_recent 条完整。
    """
    tool_indices = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    to_truncate = tool_indices[:-keep_recent] if len(tool_indices) > keep_recent else []
    changed = 0
    for idx in to_truncate:
        content = messages[idx].get("content", "")
        if len(content) > max_chars:
            messages[idx] = dict(messages[idx])  # shallow copy，不改原始对象
            messages[idx]["content"] = content[:max_chars] + "\n...[context compaction]"
            changed += 1
    if changed:
        print(f"[executor] compaction: truncated {changed} old tool results")
    return messages


def executor_react_loop(
    skill_md: str,
    user_message: str,
    mcp_tools: list,
    tm: TranscriptManager,
    max_turns: int = None,   # None = 使用安全阀 HARD_TURN_LIMIT=30
    deadline: float = None,  # Unix timestamp 截止时间（参照 OpenClaw abortSignal）
) -> dict:
    """
    Executor Agent：以 SKILL.md 为 system prompt，调用真实工具执行 Skill 功能。
    参照 OpenClaw：不使用固定轮次数限制，靠 end_turn + context budget 自然结束。
    - HARD_TURN_LIMIT=30 仅作安全阀，不是正常结束条件
    - deadline: 到期时优雅返回已收集内容，不硬断（参照 OpenClaw AbortController）
    返回 {output, tool_calls_log, turns, ok}
    """
    system = (
        skill_md.strip()
        + "\n\n---\n"
        + "## 执行规则（必须遵守）\n"
        + "\n"
        + "你是一个正在执行上述 Skill 的 AI Agent，拥有真实工具。\n"
        + "\n"
        + "**工作流程：**\n"
        + "1. **先用 web_search 搜索**获取真实 URL，禁止猜测或编造文章 URL\n"
        + "2. 用 mcp__fetch__fetch_readable 抓取搜索结果里的真实 URL 获取全文\n"
        + "3. 收集到足够信息后，直接输出最终结论（文字回复）即可完成任务\n"
        + "4. 不需要调用任何特殊工具来'提交'结果，直接写出结论就是完成\n"
        + "\n"
        + "🚫 严格禁止：\n"
        + "- 禁止 pip install / apt install\n"
        + "- 禁止用 curl/wget 代替 MCP 工具\n"
        + "- MCP 工具失败时直接换 URL，不要绕路用命令行\n"
        + "- 信息收集够了就直接输出结论，不要无限抓取新页面"
    )

    # Executor 工具集 = MCP native tools + exec + read_file + web_search(当 Tavily key 可用时)
    # 参照 OpenClaw tool catalog: web_search 是标准工具，不限于特定 skill 类型
    web_search_tools = [
        t for t in TOOLS if t["function"]["name"] == "web_search"
    ] if TAVILY_API_KEY else []
    executor_tools = mcp_tools + web_search_tools + [
        t for t in TOOLS if t["function"]["name"] in ("exec", "read_file", "write_file")
    ]
    if web_search_tools:
        print(f"[executor] web_search enabled (Tavily)", flush=True)
    else:
        print(f"[executor] web_search disabled (no TAVILY_API_KEY)", flush=True)

    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": user_message},
    ]
    # 记录 Executor 的 system prompt 到 transcript
    tm.append_system(system, label="executor")

    tool_calls_log = []        # 供 Evaluator 参考：AI 真正调用了哪些工具
    collected_outputs = []     # 兜底用
    base_system = system       # 每轮动态更新 system prompt
    case_start = time.time()   # 用于时间感知
    # 参照 OpenClaw：内层循环无硬性轮次限制，靠 context budget 和 end_turn 自然结束
    # HARD_TURN_LIMIT 只是防止失控的安全阀，不是正常结束条件
    HARD_TURN_LIMIT = max_turns if max_turns is not None else 30
    turn = 0

    while turn < HARD_TURN_LIMIT:
        turn += 1

        # ── 检查 SIGTERM / Job 超时（参照 OpenClaw AbortController）
        # 优先检查：如果收到关闭信号或 deadline 已过，优雅返回已收集内容
        remaining_job = _job_remaining()
        remaining_case = (deadline - time.time()) if deadline else float("inf")
        if _shutdown_requested or remaining_job <= 5 or remaining_case <= 5:
            reason = "SIGTERM" if _shutdown_requested else f"timeout({remaining_job:.0f}s left)"
            print(f"[executor] graceful exit at turn {turn}, reason={reason}", flush=True)
            fallback = "\n\n".join(collected_outputs) if collected_outputs else ""
            return {
                "ok": bool(collected_outputs),
                "output": fallback or f"[{reason}: incomplete]",
                "tool_calls_log": tool_calls_log,
                "turns": turn,
                "graceful_exit": True,
            }

        # ── Step 1: Preemptive Compaction（参照 OpenClaw preemptive-compaction.ts）
        pressure = _oc_estimate_tokens(messages, base_system, CONTEXT_WINDOW_TOKENS)
        route = _oc_compact_route(pressure)
        if route in ("truncate", "compact"):
            print(f"[executor] compaction route={route} pressure={pressure['pressure_pct']}% at turn {turn}")
            messages = _oc_truncate_tool_results(messages)

        # ── Step 2: 每轮更新 system prompt（含 context + 时间状态，参照 OpenClaw contextBudgetStatus）
        elapsed_case = time.time() - case_start
        time_hint = f" | 已用 {elapsed_case:.0f}s"
        if deadline:
            left = deadline - time.time()
            time_hint += f" / 剩余约 {max(0, left):.0f}s"
            if left < 40:
                time_hint += " ⚠️ 时间不多，请整合已有信息直接输出结论"
        progress_hint = f"\n\n📍 第 {turn} 轮 | Context 已用约 {pressure['pressure_pct']}%{time_hint}"
        if pressure["pressure_pct"] >= 70:
            progress_hint += " | Context 较满，信息够了请直接输出结论"
        messages[0] = {"role": "system", "content": base_system + progress_hint}

        resp = call_ai(messages, tools=executor_tools)
        choice0 = resp["choices"][0]
        msg = choice0["message"]
        msg.pop("_thinking", None)  # 清除内部字段，不影响消息历史
        messages.append(msg)

        tc_list = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip()
        if content:
            collected_outputs.append(content)

        used_model = resp.get("model") or AI_MODEL
        usage = resp.get("usage") or {}
        finish_reason = choice0.get("finish_reason", "stop")
        req_meta = {
            "method": "POST",
            "endpoint": f"{AI_BASE_URL.rstrip('/')}/chat/completions",
            "model": used_model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "stream": True,
            "tool_choice": "auto" if executor_tools else "none",
            "messages_count": len(messages) - 1,
        }

        tm.append_assistant(
            turn=turn + 1,
            content=content,
            tool_calls=[{"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]} for tc in tc_list],
            model=used_model,
            usage=usage,
            finish_reason=finish_reason,
            request_meta=req_meta,
        )

        if not tc_list:
            # 参照 OpenClaw incomplete-turn.ts：
            # stopReason = "end_turn" / "stop" → 正常完成，直接返回
            # stopReason = "length" → 被截断，注入 recovery 提示继续
            finish_reason = resp["choices"][0].get("finish_reason", "stop")
            if finish_reason == "length":
                # 被 max_tokens 截断：让 AI 继续写完（OpenClaw REASONING_ONLY_RETRY_INSTRUCTION）
                print(f"[executor] finish_reason=length at turn {turn+1}, injecting recovery")
                messages.append({
                    "role": "user",
                    "content": (
                        "你的上一条回复被截断了（达到 token 上限）。"
                        "请从截断处继续，完成完整回复，不要从头重写。"
                    )
                })
                continue
            elif not content:
                # 空响应：注入 recovery 提示（OpenClaw EMPTY_RESPONSE_RETRY_INSTRUCTION）
                print(f"[executor] empty response at turn {turn+1}, injecting recovery")
                messages.append({
                    "role": "user",
                    "content": "你没有输出任何内容。请继续完成任务，不要重新开始。"
                })
                continue
            else:
                # 有内容、无工具调用 = end_turn = 正常完成（OpenClaw 标准路径）
                print(f"[executor] end_turn at turn {turn+1}, content_len={len(content)}")
                return {
                    "ok": True,
                    "output": content,
                    "tool_calls_log": tool_calls_log,
                    "turns": turn + 1,
                }

        for tc in tc_list:
            t_name = tc["function"]["name"]
            t_args = json.loads(tc["function"]["arguments"])

            result_str = dispatch_tool(t_name, t_args)

            # 记录工具调用（供 Evaluator 判断"是否真正用了工具"）
            try:
                result_preview = json.loads(result_str)
                out_preview = str(result_preview.get("stdout", result_str))[:300]
            except Exception:
                out_preview = result_str[:300]
            tool_calls_log.append({
                "tool": t_name,
                "args_preview": str(t_args)[:200],
                "output_preview": out_preview,
            })

            tm.append_tool_call(
                turn=turn + 1,
                tool_name=t_name,
                tool_input=t_args,
                tool_output=result_str,
                tool_call_id=tc["id"],
            )
            max_chars = calculate_max_chars(CONTEXT_WINDOW_TOKENS)
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": truncate_tool_result(result_str, max_chars),
            })


    # 达到最大轮次：用已收集的中间文字输出作为兜底（总比"未能给出回复"好）
    fallback = "\n\n".join(collected_outputs) if collected_outputs else "Executor 达到最大轮次，未能给出最终回复"
    return {
        "ok": bool(collected_outputs),
        "output": fallback,
        "tool_calls_log": tool_calls_log,
        "turns": max_turns,
    }



# ─── Evaluator Agent（严格评测，无工具）────────────────────────────────────────
EVALUATOR_SYSTEM_PROMPT = """
你是一个严格的 Skill 质量评估专家。

## 评估原则

你会收到：SKILL.md 原文、每个测试用例的用户输入、Executor AI 的实际输出、以及 Executor 实际调用的工具记录。

评估时必须参考「工具调用记录」：
- 如果 Executor 调用了真实工具（MCP / exec）并从工具获取数据 → 可以给高分
- 如果 Executor 没有调用任何工具，仅凭 AI 内部知识给出答案 → 最高 45 分，passed=false
- 如果 Executor 调用了工具但工具失败（403/404 等网络问题），Skill 逻辑正确 → 60-69 分，passed=true

## 评分标准（严格）

| 分数 | 含义 |
|------|------|
| 90-100 | 完美：工具调用成功，结果来自真实数据，内容准确完整 |
| 80-89 | 优秀：主流程成功，有小瑕疵 |
| 70-79 | 良好：大部分工作，有一个 case 失败 |
| 60-69 | 及格：工具调用失败但因外部原因（网络/认证），Skill 本身逻辑正确 |
| 40-59 | 不及格：Executor 主要靠 AI 内部知识而非真实工具，即使内容看起来合理 |
| 0-39 | 差：Skill 逻辑本身有缺陷，或完全未执行 |

## 输出格式

直接输出 JSON，不要用代码块包裹：
{
  "passed": true/false,
  "score": 0-100,
  "output": "一句话总结",
  "notes": "详细评价，必须提及工具调用情况",
  "test_results": [
    {
      "case": "test_case_1",
      "input": "用户输入",
      "response": "Executor 输出（不要截断）",
      "evaluation": "对这条结果的评价，必须说明是否真正用了工具"
    }
  ]
}
""".strip()


def evaluator_call(
    skill_md: str,
    test_cases: list,
    executor_results: list,
    tm: TranscriptManager,
) -> dict:
    """
    Evaluator Agent：无工具，收到 Executor 结果后严格评分。
    """
    cases_str = "\n\n".join([
        f"### 用例 {i+1}\n**用户输入**：{tc}\n\n"
        f"**Executor 实际输出**：\n{res.get('output', '')[:8000]}\n\n"
        f"**实际工具调用记录**（用于判断是否真正获取了数据）：\n"
        f"{json.dumps(res.get('tool_calls_log', []), ensure_ascii=False)}"
        for i, (tc, res) in enumerate(zip(test_cases, executor_results))
    ])

    user_content = (
        f"## SKILL.md\n\n{skill_md[:5000]}\n\n"
        f"## 各测试用例执行结果\n\n{cases_str}"
    )

    tm.append_system(EVALUATOR_SYSTEM_PROMPT, label="evaluator")
    resp = call_ai(
        messages=[
            {"role": "system", "content": EVALUATOR_SYSTEM_PROMPT},
            {"role": "user",   "content": user_content},
        ],
        tools=None,
    )
    raw = resp["choices"][0]["message"].get("content", "{}")
    # 去掉可能的 markdown 代码块
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        return json.loads(raw)
    except Exception:
        return {
            "passed": False,
            "score": 0,
            "output": "Evaluator 输出无法解析为 JSON",
            "notes": raw[:500],
            "test_results": [],
        }



def react_loop(system_prompt: str, user_msg: str) -> dict:
    """返回 {"output": str, "tm": TranscriptManager} — 使用 OpenClaw 风格的双份 Transcript"""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_msg},
    ]
    # 创建 TranscriptManager（双份 JSONL：完整版 + 截断版）
    tm = TranscriptManager(
        work_dir="/tmp/transcript",
        skill_id=SKILL_ID,
        context_tokens=CONTEXT_WINDOW_TOKENS,
    )
    tm.append_event("start", f"开始测试 skill_id={SKILL_ID}")
    # 记录 system prompt（完整版存 full transcript，让上下文可还原）
    tm.append_system(system_prompt, label="orchestrator")

    for turn in range(12):
        # OpenClaw-style context pressure check + pruning
        from truncation import context_pressure_check, truncate_messages_recovery
        pressure = context_pressure_check(messages, context_window_tokens=CONTEXT_WINDOW_TOKENS)
        if pressure["critical"]:
            # 紧急恢复模式：激进截断
            messages = truncate_messages_recovery(messages, context_window_tokens=CONTEXT_WINDOW_TOKENS)
            tm.append_event("recovery", f"context pressure {pressure['pressure_ratio']} — 触发 recovery 截断")
            progress("上下文压力", f"已达 {int(pressure['pressure_ratio']*100)}%，触发 recovery 截断")
        elif pressure["warning"]:
            messages = prune_context(messages)
            tm.append_event("prune", f"context pressure {pressure['pressure_ratio']} — 触发 prune")
        else:
            messages = prune_context(messages)

        # 后 4 轮：注入强制完成指令，停止传工具
        if turn >= 8:
            if messages[-1].get("role") != "user" or "JSON" not in messages[-1].get("content", ""):
                messages.append({
                    "role": "user",
                    'content': '你已完成足够的分析。请立即停止调用工具，直接输出最终评测结果（纯 JSON 格式，不要包含 markdown 代码块）。'
                })
            tools_this_turn = None   # 禁用工具，强制文本输出
        else:
            tools_this_turn = TOOLS

        ctx_k = estimate_chars(messages) // 1000
        progress(f"turn_{turn+1}", f"AI 思考中（上下文约 {ctx_k}k 字符）")
        resp = call_ai(messages, tools=tools_this_turn)
        choice = resp["choices"][0]
        msg = choice["message"]
        messages.append(msg)

        # 记录 AI 回复到 TranscriptManager（自动脱敏 + 双份存储）
        tm.append_assistant(
            turn=turn + 1,
            content=msg.get("content", ""),
            tool_calls=[{"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]} for tc in (msg.get("tool_calls") or [])],
        )

        # 没有 tool_call → AI 给出最终答案
        tool_calls = msg.get("tool_calls") or []
        content_text = msg.get("content") or ""
        if not tool_calls:
            if not content_text.strip():
                progress("完成", "AI 返回空响应，视为测试结束")
                return {"output": "测试完成。", "tm": tm}
            progress("完成", "AI 已给出测试结论")
            return {"output": content_text, "tm": tm}

        # 有 tool_call → 执行工具
        for tc in msg["tool_calls"]:
            name = tc["function"]["name"]
            args = json.loads(tc["function"]["arguments"])
            tool_label = {"exec": "执行命令", "read_file": "读取文件", "write_file": "写入文件", "http_get": "HTTP请求"}.get(name, name)
            progress(f"工具:{tool_label}", args.get("command", args.get("path", args.get("url", "")))[:80])
            result_str = dispatch_tool(name, args)

            # 记录工具输出到 TranscriptManager（自动落盘大文件 + 智能截断 + 脱敏）
            tm.append_tool_call(
                turn=turn + 1,
                tool_name=name,
                tool_input=args,
                tool_output=result_str,
                tool_call_id=tc["id"],
            )

            # 把工具执行结果也发回进度（让前端能看到完整输出）
            if name == "exec" and len(result_str) > 10:
                progress(f"输出:{tool_label}", result_str[:4000])

            # OpenClaw 风格智能截断 — 保留头+尾，不丢错误信息
            max_chars = calculate_max_chars(CONTEXT_WINDOW_TOKENS)
            truncated = truncate_tool_result(result_str, max_chars)
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": truncated,
            })

        # 每轮后做聚合截断（防止总 tool output 超 context 50%）
        messages = truncate_messages_aggregate(messages, context_window_tokens=CONTEXT_WINDOW_TOKENS)

    return {"output": "已达最大轮次上限", "tm": tm}

# ─── 结果写回 Supabase ────────────────────────────────────────────────────────
def save_result(result: dict):
    if not DB_URL:
        print("[save] no DB_URL, skipping", flush=True)
        return
    try:
        import urllib.request
        # transcript 已经是 TranscriptManager 的截断版，无需再压缩

        callback_url = os.environ.get("CALLBACK_URL", "")
        if callback_url:
            data = json.dumps(result, ensure_ascii=False).encode("utf-8")
            print(f"[save] callback body size: {len(data)} bytes", flush=True)
            req = urllib.request.Request(
                callback_url, data=data,
                headers={"Content-Type": "application/json", "X-Sandbox-Secret": os.environ.get("SANDBOX_SECRET","")},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=30)
            print("[save] result sent via callback", flush=True)
    except Exception as e:
        print(f"[save] error: {e}", flush=True)

# ─── 主入口 ───────────────────────────────────────────────────────────────────
def main():
    start = time.time()
    progress("启动", f"开始测试 skill_id={SKILL_ID}")

    # 自动配置已保存的 MCP 服务
    auto_configure_mcp()

    # 动态发现 MCP tools，注册为 native function calling 工具
    mcp_native_tools = discover_mcp_tools()
    if mcp_native_tools:
        TOOLS.extend(mcp_native_tools)
        print(f"[MCP-discover] 共注册 {len(mcp_native_tools)} 个 MCP native tools", flush=True)

    if not SKILL_MD:
        progress("错误", "SKILL.md 内容为空，无法测试")
        sys.exit(1)

    system_prompt = textwrap.dedent(f"""
        你是一个专业的 Skill 测试 Agent，运行在 Linux 沙箱里。
        你负责对 Skill 进行三阶段测试：

        ═══════════════════════════════════════════════════════
        📋 阶段 1：分析 & 生成测试输入
        ═══════════════════════════════════════════════════════
        - 阅读 SKILL.md，理解 Skill 的功能、类型和预期行为
        - 判断 Skill 类型：
            * 纯提示词型（Prompt Skill）：SKILL.md 只有描述和 prompt，没有脚本代码
            * 脚本型（Script Skill）：SKILL.md 有 scripts/ 或需要执行命令
        - 如果系统提供了预生成的测试输入，直接使用；否则自己生成 2-3 个测试用例

        ═══════════════════════════════════════════════════════
        🚀 阶段 2：执行 Skill（子 Agent 模式）
        ═══════════════════════════════════════════════════════
        对 prompt-only Skill：
        - 使用 invoke_skill 工具，只传 user_message（测试用例内容）
        - ⚠️ 不要传 skill_system_prompt 参数——Skill 内容已在系统中自动加载，无需重复传入
        - invoke_skill 会以 Skill 的身份回答，返回真实的 Skill 输出
        - 每个测试用例调用一次 invoke_skill
        - ⚠️ 【重要】如果用户消息区有"## 附件内容"部分，调用 invoke_skill 时必须把附件内容完整追加到 user_message 末尾
          示例：user_message="请分析这份体检报告\n\n## 附件内容（共 1 个文件）\n【PDF 文件：xxx.pdf...（全文）】"
          原因：invoke_skill 是独立子调用，附件内容不会自动传入，必须显式携带


        对 script Skill：
        - 用 exec 工具执行 Skill 的脚本
        - 把测试输入传给脚本，收集输出

        🔌 MCP 工具支持（已自动配置为 native tools）：
        - 如果 SKILL.md 有 `requires.bins: ["mcporter"]`，MCP 工具已在启动时自动发现并注册
        - 可用的 MCP 工具以 native function calling 形式提供，名称格式：mcp__<server>__<tool>
        - 直接调用这些工具，无需通过 exec 运行 mcporter 命令行
        - 例：若 fetch server 有 fetch_html 工具 → 直接调用 mcp__fetch__fetch_html(url='https://...')
        - 返回 {{stdout, stderr, exit_code}}，stdout 为工具原始输出

        ═══════════════════════════════════════════════════════
        🏆 阶段 3：评估 & 输出结果
        ═══════════════════════════════════════════════════════
        - 对每个测试用例的回复，评估：
            * 是否符合 Skill 的描述和预期功能
            * 回复质量（准确性、完整性、有用性）
            * 是否遵守了 SKILL.md 里的约束条件
        - 给出综合评分和总结
        - 最后一轮直接输出 JSON 结果（不要用代码块包裹）：
        {{
          "passed": true/false,
          "score": 0-100,
          "output": "整体评测摘要",
          "notes": "详细说明",
          "test_results": [
            {{
              "case": "test_case_1",
              "input": "用户的原始输入",
              "response": "Skill 给出的完整回复原文（不要截断）",
              "evaluation": "对这条回复的评价"
            }}
          ]
        }}

        🚫 禁止行为：
        - 禁止用 bash/shell 脚本构造 JSON 请求体来调用 AI API（极易出错）
        - 禁止创建虚拟环境（python3 -m venv / virtualenv）
        - 禁止安装已预装的包

        📦 沙箱已预装（无需 pip install）：
        - requests, httpx, PyPDF2, pdfplumber, python-docx, python-pptx
        - Pillow, pytesseract, pandas, numpy, openai
        - 系统工具：curl, wget, jq, git, nodejs, npm, tesseract-ocr

        📊 评分准则：
        - 90-100：所有测试用例通过，回复质量高
        - 70-89：主流程工作，有小问题
        - 60-69：外部服务不可用但 Skill 逻辑正确 → passed=true
        - 40-59：部分功能工作
        - 0-39：Skill 逻辑本身有缺陷
        ⚠️ 如果失败是「需要认证」「外部服务不可用」等环境问题，给 60-69 分并 passed=true。
    """).strip()


    # ── 提取附件列表（从 USER_INPUTS 中取出 __attachments__，不计入 CASE_COUNT）──
    _raw_attachments: list = []
    if isinstance(USER_INPUTS, dict) and "__attachments__" in USER_INPUTS:
        _raw_attachments = USER_INPUTS.pop("__attachments__", []) or []
        print(f"[main] Found {len(_raw_attachments)} attachment(s): {_raw_attachments}", flush=True)

    # 按 CASE_COUNT 截取测试用例（prompt 路径和 mcp 路径共用）
    if isinstance(USER_INPUTS, dict):
        _all_kv = list(USER_INPUTS.items())[:CASE_COUNT]
        _limited_inputs = dict(_all_kv)
    elif isinstance(USER_INPUTS, list):
        _limited_inputs = USER_INPUTS[:CASE_COUNT]
    else:
        _limited_inputs = USER_INPUTS
    _orig_len = len(USER_INPUTS) if isinstance(USER_INPUTS, (dict, list)) else 1
    _lim_len  = len(_limited_inputs) if isinstance(_limited_inputs, (dict, list)) else 1
    print(f"[main] CASE_COUNT={CASE_COUNT}, cases: {_orig_len} → {_lim_len}", flush=True)

    # ── 解析附件内容 ──────────────────────────────────────────────────────────
    def _extract_attachment_content(gcs_path: str) -> str:
        """从 GCS 下载文件并提取文本内容，返回格式化字符串"""
        import os as _os, tempfile as _tmp
        filename = gcs_path.split("/")[-1]
        ext = _os.path.splitext(filename)[1].lower()
        tmp_path = _os.path.join(_tmp.gettempdir(), f"_attach_{filename}")
        try:
            from google.cloud import storage as gcs_lib
            client = gcs_lib.Client()
            bucket_name = gcs_path.replace("gs://", "").split("/")[0]
            blob_name = "/".join(gcs_path.replace("gs://", "").split("/")[1:])
            blob = client.bucket(bucket_name).blob(blob_name)
            blob.download_to_filename(tmp_path)
            print(f"[attachment] downloaded {filename} ({_os.path.getsize(tmp_path)} bytes)", flush=True)
        except Exception as _e:
            print(f"[attachment] GCS download failed for {filename}: {_e}", flush=True)
            return f"[附件 {filename} 下载失败: {_e}]"
        try:
            if ext == ".pdf":
                import pdfplumber
                pages_text = []
                with pdfplumber.open(tmp_path) as pdf:
                    total = len(pdf.pages)
                    for i, page in enumerate(pdf.pages[:30], 1):
                        text = page.extract_text() or ""
                        if text.strip():
                            pages_text.append(f"--- 第 {i}/{total} 页 ---\n{text.strip()}")
                content = "\n\n".join(pages_text) or "[PDF 内容为空或无法提取文字]"
                return f"【PDF 文件：{filename}，共 {total} 页】\n{content}"
            elif ext == ".docx":
                import docx as _docx
                doc = _docx.Document(tmp_path)
                paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
                content = "\n".join(paragraphs) or "[Word 文档内容为空]"
                return f"【Word 文件：{filename}】\n{content}"
            elif ext == ".doc":
                return f"[附件 {filename} 为旧版 .doc 格式，请转为 .docx 或 PDF]"
            elif ext in (".txt", ".md", ".csv"):
                with open(tmp_path, "r", encoding="utf-8", errors="replace") as _f:
                    text = _f.read(50000)
                return f"【文本文件：{filename}】\n{text}"
            elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                import base64 as _b64
                with open(tmp_path, "rb") as _f:
                    b64_data = _b64.b64encode(_f.read()).decode()
                mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                            ".webp": "image/webp", ".gif": "image/gif"}
                mime = mime_map.get(ext, "image/jpeg")
                return f"__IMAGE_ATTACHMENT__:{mime}:{b64_data}"
            else:
                return f"[附件 {filename} 格式暂不支持：{ext}]"
        except Exception as _e:
            print(f"[attachment] parse error for {filename}: {_e}", flush=True)
            return f"[附件 {filename} 解析出错: {_e}]"
        finally:
            try:
                _os.remove(tmp_path)
            except Exception:
                pass

    _attachment_blocks: list = []
    for _gcs_path in _raw_attachments:
        _attachment_blocks.append(_extract_attachment_content(_gcs_path))

    _attachment_section = ""
    if _attachment_blocks:
        _attachment_section = "\n\n## 附件内容（共 {} 个文件）\n{}".format(
            len(_attachment_blocks), "\n\n".join(_attachment_blocks))
        print(f"[main] Attachment section: {len(_attachment_section)} chars total", flush=True)

    _is_manual = _lim_len > 0 and isinstance(_limited_inputs, dict) and "用户输入" in _limited_inputs
    _inputs_json = json.dumps(_limited_inputs, ensure_ascii=False, indent=2)
    _manual_warning = "\n⚠️ [手工指定] 请严格只使用下方这一个场景进行测试，不要自行添加其他用户或测试用例。" if _is_manual else ""
    _manual_suffix = " (加载以上手工填写的输入，只跑这一个用例)" if _is_manual else ""
    user_msg = (
        f"## SKILL.md 内容\n{SKILL_MD}\n\n"
        f"## 测试输入{_manual_warning}\n{_inputs_json}"
        f"{_attachment_section}\n\n"
        f"请开始测试这个 Skill{_manual_suffix}."
    ).strip()

    tm: Optional[TranscriptManager] = None
    result: dict = {
        "skill_id": SKILL_ID,
        "passed": False,
        "output": "Job did not complete",
        "duration_ms": 0,
        "tested_at": datetime.now(timezone.utc).isoformat(),
        "transcript": [],  # 空 transcript，前端应显示"无数据"而非旧缓存
    }

    # 检测 Skill 类型，决定走哪条路径
    skill_type = detect_skill_type(SKILL_MD)
    print(f"[main] detected skill_type={skill_type}", flush=True)
    progress("分析", f"Skill 类型：{skill_type}")

    try:
        if TICKET_MODE:
            # ── 工单模式：适用于所有 skill_type，跳过全部测试/评估逻辑 ──────────
            # 直接用 SKILL.md 作 Agent 指令，客户提交的数据作 user message
            # 结果是客户真正应该看到的内容，不是评分 JSON
            ticket_tm = TranscriptManager(
                work_dir="/tmp/transcript",
                skill_id=SKILL_ID,
                context_tokens=CONTEXT_WINDOW_TOKENS,
            )
            ticket_tm.append_event("start", f"工单模式 (skill_type={skill_type})")

            # 明确打印 SKILL.md 前 200 字，供日志确认实际使用的 Skill 内容
            skill_preview = SKILL_MD.strip()[:200].replace('\n', ' | ')
            print(f"[ticket-mode] SKILL_ID={SKILL_ID}", flush=True)
            print(f"[ticket-mode] SKILL_MD 前200字: {skill_preview}", flush=True)
            ticket_tm.append_event("skill_loaded", f"Skill 内容已加载 ({len(SKILL_MD)} 字符)：{SKILL_MD.strip()[:120]}…")

            # 取第一个（也是唯一的）test case 作为客户输入
            if isinstance(_limited_inputs, dict):
                customer_message = list(_limited_inputs.values())[0] if _limited_inputs else str(_limited_inputs)
            elif isinstance(_limited_inputs, list):
                customer_message = _limited_inputs[0] if _limited_inputs else str(_limited_inputs)
            else:
                customer_message = str(_limited_inputs)

            # ── 将附件内容追加到 customer_message（ticket mode 专用路径）──────
            # _attachment_section 在非 ticket 模式下已拼入 user_msg，但 ticket 模式
            # 走独立路径，需要在此处单独追加，否则 Agent 永远看不到 PDF 内容
            if _attachment_section:
                customer_message = str(customer_message) + _attachment_section
                print(f"[ticket-mode] Appended attachment section ({len(_attachment_section)} chars) to customer_message", flush=True)

            ticket_deadline = time.time() + max(60, _JOB_TIMEOUT_SECONDS - _job_elapsed() - 30)
            progress("执行", f"Agent 正在处理客户请求...")

            e_result = executor_react_loop(
                skill_md=SKILL_MD,
                user_message=str(customer_message),
                mcp_tools=mcp_native_tools,
                tm=ticket_tm,
                deadline=ticket_deadline,
            )
            executor_output = e_result.get("output", "")
            duration_ms = int((time.time() - start) * 1000)

            result.update({
                "passed":    bool(executor_output),
                "output":    executor_output,      # Agent 实际输出（客户看到的内容）
                "transcript": ticket_tm.get_display_entries(),
                "model":     AI_MODEL,
                "duration_ms": duration_ms,
                "tested_at": datetime.now(timezone.utc).isoformat(),
            })
            tm = ticket_tm
            progress("完成", f"Agent 执行完毕（工单模式），输出 {len(executor_output)} 字")
            # 不继续走 sandbox 测试路径
        elif skill_type in ("mcp", "script"):
            # ── 双 Agent 路径：Executor + Evaluator ──────────────────────────
            # 创建 TranscriptManager
            tm = TranscriptManager(
                work_dir="/tmp/transcript",
                skill_id=SKILL_ID,
                context_tokens=CONTEXT_WINDOW_TOKENS,
            )
            tm.append_event("start", f"双 Agent 模式，skill_type={skill_type}")

            # 解析测试用例，按 CASE_COUNT 截取（前端可配置1-3，默认1）
            if isinstance(USER_INPUTS, dict):
                test_cases = list(USER_INPUTS.values())
            elif isinstance(USER_INPUTS, list):
                test_cases = USER_INPUTS
            else:
                test_cases = [str(USER_INPUTS)]
            test_cases = test_cases[:CASE_COUNT]
            n_cases = len(test_cases)

            # 每个用例独立享有完整 PER_CASE_BUDGET（不平分总时间）
            # 参照：如果是独立的 Cloud Run job，每次都有完整 600s，这里保持相同逻辑
            _per_case = min(PER_CASE_BUDGET, max(60, _job_remaining() - EVALUATOR_BUDGET - 10))
            print(f"[main] test_cases={n_cases}, per_case_budget={_per_case:.0f}s (PER_CASE_BUDGET={PER_CASE_BUDGET}s, job_remaining={_job_remaining():.0f}s)", flush=True)

            # Executor 依次执行每个测试用例
            executor_results = []
            for i, case in enumerate(test_cases):
                # 每用例前检查 SIGTERM 或总时间不足
                if _shutdown_requested or _job_remaining() <= EVALUATOR_BUDGET:
                    print(f"[main] skipping case {i+1}/{n_cases}: shutdown or timeout", flush=True)
                    progress(f"跳过用例 {i+1}", "Job 即将结束，跳过剩余用例")
                    break

                case_deadline = time.time() + _per_case
                progress(f"执行用例 {i+1}/{n_cases}", str(case)[:80])
                tm.append_event("executor_start", f"用例 {i+1}: {str(case)[:100]}")
                e_result = executor_react_loop(
                    skill_md=SKILL_MD,
                    user_message=str(case),
                    mcp_tools=mcp_native_tools,
                    tm=tm,
                    deadline=case_deadline,
                )
                executor_results.append(e_result)
                tm.append_event("executor_done", f"用例 {i+1} 完成，turns={e_result['turns']}, ok={e_result['ok']}")
                progress(f"用例 {i+1} 完成", f"ok={e_result['ok']}, turns={e_result['turns']}")

            # Evaluator 严格评分
            progress("评估", "Evaluator 严格评估中...")
            eval_result = evaluator_call(
                skill_md=SKILL_MD,
                test_cases=test_cases,
                executor_results=executor_results,
                tm=tm,
            )

            duration_ms = int((time.time() - start) * 1000)
            display_transcript = tm.get_display_entries()

            if TICKET_MODE:
                # ── 工单模式：跳过 Evaluator，直接用 Executor 的实际输出 ──────
                # 客户看到的是 Agent 实际生成的内容，不是评分 JSON
                executor_output = ""
                if executor_results:
                    executor_output = executor_results[0].get("output", "")
                result = {
                    "skill_id": SKILL_ID,
                    "passed":   bool(executor_output),
                    "output":   executor_output,       # Executor 实际输出（客户看到的）
                    "transcript": display_transcript,
                    "model":    AI_MODEL,
                    "duration_ms": duration_ms,
                    "tested_at": datetime.now(timezone.utc).isoformat(),
                }
                progress("完成", f"Agent 执行完毕（工单模式），输出 {len(executor_output)} 字")
            else:
                # ── 测试模式：Evaluator 严格评分 ─────────────────────────────
                progress("评估", "Evaluator 严格评估中...")
                eval_result = evaluator_call(
                    skill_md=SKILL_MD,
                    test_cases=test_cases,
                    executor_results=executor_results,
                    tm=tm,
                )
                output = json.dumps(eval_result, ensure_ascii=False)
                result = {
                    "skill_id": SKILL_ID,
                    "passed": eval_result.get("passed", False),
                    "output": output,
                    "transcript": display_transcript,
                    "testInput": json.dumps(_limited_inputs, ensure_ascii=False),
                    "model": AI_MODEL,
                    "duration_ms": duration_ms,
                    "tested_at": datetime.now(timezone.utc).isoformat(),
                }

        else:
            # ── 旧路径：prompt-only Skill，用 react_loop + invoke_skill ──────
            loop_result = react_loop(system_prompt, user_msg)
            output = loop_result["output"]
            tm = loop_result.get("tm")
            duration_ms = int((time.time() - start) * 1000)
            display_transcript = tm.get_display_entries() if tm else []
            result = {
                "skill_id": SKILL_ID,
                "passed": True,
                "output": output,
                "transcript": display_transcript,
                "testInput": json.dumps(_limited_inputs, ensure_ascii=False),
                "model": AI_MODEL,
                "duration_ms": duration_ms,
                "tested_at": datetime.now(timezone.utc).isoformat(),
            }

    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        result.update({
            "passed": False,
            "output": f"Job FAILED: {str(e)}",
            "duration_ms": duration_ms,
            # transcript 保留已有的（哪怕是空列表）—— 告诉前端"本次无数据"
            "transcript": tm.get_display_entries() if tm else [],
        })
        progress("错误", f"测试异常：{str(e)[:100]}")

    finally:
        # 无论成功还是失败，都保存结果并上传 GCS
        # 这样 Job FAILED 时前端也能看到正确状态，不会显示旧缓存
        print(f"[RESULT] {json.dumps(result, ensure_ascii=False)}", flush=True)
        save_result(result)

        if tm:
            try:
                gcs_paths = tm.upload_to_gcs("skill-platform-bundles-0884226164")
                print(f"[transcript] uploaded to GCS: {gcs_paths}", flush=True)
            except Exception as e:
                print(f"[transcript] GCS upload failed: {e}", flush=True)

if __name__ == "__main__":
    main()
