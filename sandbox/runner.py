"""
sandbox/runner.py  — AI Agent sandbox runner
参考 OpenClaw bash-tools 设计，AI 读 SKILL.md 然后用 exec 工具执行任务
"""
import os, sys, json, subprocess, time, textwrap, base64, re, shlex
from datetime import datetime, timezone

# OpenClaw 风格模块
from transcript import TranscriptManager
from truncation import truncate_tool_result, calculate_max_chars, truncate_messages_aggregate
from redact import redact_secrets

# ─── 环境变量 ─────────────────────────────────────────────────────────────────
SKILL_ID      = os.environ.get("SKILL_ID", "")
SKILL_MD_B64  = os.environ.get("SKILL_MD", "")          # base64 编码的 SKILL.md
USER_INPUTS   = json.loads(os.environ.get("USER_INPUTS", "{}"))
AI_API_KEY    = os.environ.get("AI_API_KEY", "")
AI_BASE_URL   = os.environ.get("AI_BASE_URL", "")       # doubao/deepseek endpoint
AI_MODEL      = os.environ.get("AI_MODEL", "")
DB_URL        = os.environ.get("DATABASE_URL", "")
DB_SCHEMA     = os.environ.get("DB_SCHEMA", "skill_platform")
SKILL_MD      = base64.b64decode(SKILL_MD_B64).decode("utf-8") if SKILL_MD_B64 else ""
CALLBACK_URL  = os.environ.get("CALLBACK_URL", "")      # 进度回调 URL（存入 DB 供前端实时展示）
SANDBOX_SECRET = os.environ.get("SANDBOX_SECRET", "")
MCP_CONFIGS   = os.environ.get("MCP_CONFIGS", "[]")      # JSON array: [{name, command, args}]
OAUTH_TOKENS  = os.environ.get("OAUTH_TOKENS", "")       # JSON: {provider/mcp_name: {access_token, token_type, scope, expiry_date, ...}}

# Fallback AI provider
FALLBACK_API_KEY  = os.environ.get("FALLBACK_AI_API_KEY", "")
FALLBACK_BASE_URL = os.environ.get("FALLBACK_AI_BASE_URL", "")

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
    "deepseek-coder":               {"context_window": 64_000,  "max_output": 8_192,   "max_input": 56_000,  "provider": "deepseek"},
    "deepseek-reasoner":            {"context_window": 64_000,  "max_output": 16_000,  "max_input": 56_000,  "provider": "deepseek"},
    # ── Gemini 系列（如有）─────────────────────────────────────────────────
    "gemini-2.0-flash":             {"context_window": 1_048_576, "max_output": 8_192, "max_input": 1_040_000, "provider": "google"},
    "gemini-1.5-pro":               {"context_window": 2_097_152, "max_output": 8_192, "max_input": 2_090_000, "provider": "google"},
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
MAX_OUTPUT_TOKENS     = min(_CURRENT_MODEL_CONFIG["max_output"], 16_000)  # 沙箱场景下 16k 足够
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
            timeout=120,
        )
        choice = resp.get("choices", [{}])[0]
        reply = choice.get("message", {}).get("content", "")
        usage = resp.get("usage", {})
        print(f"[invoke_skill] reply={reply[:120]!r} tokens={usage}", flush=True)
        return {"ok": True, "response": reply, "usage": usage}
    except Exception as e:
        print(f"[invoke_skill] error: {e}", flush=True)
        return {"ok": False, "error": str(e)}

# ─── 进度上报（stdout + HTTP POST 到平台，实时写入 DB 供前端展示）──────────────
def _post_progress(msg: dict):
    if not CALLBACK_URL:
        return
    try:
        import urllib.request as _ur
        data = json.dumps({"type": "progress", "event": msg, "secret": SANDBOX_SECRET}).encode()
        req = _ur.Request(CALLBACK_URL, data=data,
                          headers={"Content-Type": "application/json"}, method="POST")
        _ur.urlopen(req, timeout=5)
    except Exception:
        pass  # 进度上报失败不影响主流程

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
            "name": "invoke_skill",
            "description": (
                "以 Skill 的 system prompt 身份，向 AI 发送一条用户消息，返回 Skill 的回复。"
                " 用于测试 prompt-only Skill：把 SKILL.md 正文作为 system，测试用例作为 user。"
                " 也可用于 script Skill 的 warm-up 检测（看 AI 对 Skill 指令的理解）。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "user_message": {
                        "type": "string",
                        "description": "发给 Skill 的用户消息（即一条测试用例的内容）"
                    },
                    "skill_system_prompt": {
                        "type": "string",
                        "description": "可选：指定 Skill 的 system prompt。留空则自动使用当前 SKILL.md 全文。"
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
def _do_ai_call(messages: list, tools=None, timeout=180,
                api_key: str = None, base_url: str = None) -> dict:
    """Single AI call to a specific provider."""
    import urllib.request, urllib.error
    key  = api_key  or AI_API_KEY
    base = base_url or AI_BASE_URL
    body = {"model": AI_MODEL, "messages": messages, "max_tokens": MAX_OUTPUT_TOKENS}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body_str = e.read().decode()
        raise RuntimeError(f"AI API error {e.code}: {body_str}")

def call_ai(messages: list, tools=None) -> dict:
    """
    3-level fallback (OpenClaw FailoverError pattern):
    Level 1: Primary provider + tools
    Level 2: Fallback provider + tools (Doubao <-> DeepSeek)
    Level 3: Primary provider, no tools, simplified context
    """
    try:
        return _do_ai_call(messages, tools, timeout=180)
    except (RuntimeError, Exception) as e1:
        err1 = str(e1)
        print(f"[call_ai] L1 failed: {err1[:100]}", flush=True)

        # Level 2: switch to fallback provider
        if FALLBACK_API_KEY and FALLBACK_BASE_URL:
            try:
                print(f"[call_ai] L2 trying fallback provider...", flush=True)
                return _do_ai_call(messages, tools, timeout=180,
                                   api_key=FALLBACK_API_KEY, base_url=FALLBACK_BASE_URL)
            except Exception as e2:
                print(f"[call_ai] L2 failed: {str(e2)[:80]}", flush=True)

        # Level 3: no tools + simplified context
        if "tool" in err1.lower() or "output" in err1.lower() or "empty" in err1.lower():
            print("[call_ai] L3 retry: no tools, simplified context", flush=True)
            sys_msg = [m for m in messages if m.get("role") == "system"]
            usr_msg = [m for m in messages if m.get("role") == "user"]
            simple = sys_msg + (usr_msg[-1:] if usr_msg else [])
            simple.append({"role": "user", "content": "Please output the final test result as JSON only."})
            return _do_ai_call(simple, tools=None, timeout=120)
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

# 改进 B：submit_result 工具（参照 OpenClaw update_goal(complete) 设计）
# AI 主动调用来宣布任务完成，不再依赖"不调用工具"这个模糊信号
SUBMIT_RESULT_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_result",
        "description": (
            "当你认为已收集到足够信息，调用此工具提交最终结果。"
            "调用后任务立即结束，content 将作为最终输出。"
            "不要在调用此工具后再调用其他工具。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "最终结果的完整文字内容，必须包含实质性内容，不能是空字符串"
                }
            },
            "required": ["content"]
        }
    }
}

def executor_react_loop(
    skill_md: str,
    user_message: str,
    mcp_tools: list,
    tm: TranscriptManager,
    max_turns: int = 12,
) -> dict:
    """
    Executor Agent：以 SKILL.md 为 system prompt，调用真实工具执行 Skill 功能。
    返回 {output, tool_calls_log, turns, ok}
    """
    system = (
        skill_md.strip()
        + "\n\n---\n"
        + "⚠️ 你是一个正在执行这个 Skill 的 AI Agent。\n"
        + "- 你有真实的工具可以直接调用（MCP native tools 名称格式：mcp__<server>__<tool>）\n"
        + "- 直接调用工具完成任务，不要只在文字里描述你打算做什么\n"
        + "- 信息收集完毕后，调用 submit_result 工具提交最终结果（不要只用文字输出）\n"
        + "- MCP 工具调用格式：直接 function calling，参数按工具 schema 填写\n"
        + "\n"
        + "🚫 严格禁止：\n"
        + "- 禁止 pip install / apt install（沙箱包已固定，安装会失败且浪费轮次）\n"
        + "- 禁止用 curl/wget 作为 MCP 工具的 fallback（MCP 工具失败就换 URL，不要 curl）\n"
        + "- MCP 工具返回错误时，直接换另一个 URL 再试，不要绕路用命令行\n"
        + "- 轮次有限，每轮必须推进实质进展\n"
        + "\n"
        + "✅ 结束方式：收集到足够信息后，调用 submit_result(content=...) 提交结论。"
    )

    # Executor 工具集 = MCP native tools + exec + read_file + submit_result
    executor_tools = mcp_tools + [
        t for t in TOOLS if t["function"]["name"] in ("exec", "read_file", "write_file")
    ] + [SUBMIT_RESULT_TOOL]

    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": user_message},
    ]
    # 记录 Executor 的 system prompt 到 transcript
    tm.append_system(system, label="executor")

    tool_calls_log = []  # 供 Evaluator 参考：AI 真正调用了哪些工具
    collected_outputs = []  # 收集中间文字输出，用于 max_turns 兜底
    base_system = system   # 改进 A：保存基础 system prompt，每轮追加进度信息

    for turn in range(max_turns):
        # 改进 A：每轮动态更新 system prompt（参照 OpenClaw contextBudgetStatus）
        # 替代之前"倒数第 2 轮注入假 user 消息"的 hack
        remaining = max_turns - turn - 1
        progress_hint = (
            f"\n\n📍 当前进度：第 {turn + 1} 轮 / 共 {max_turns} 轮，剩余 {remaining} 轮。"
        )
        if remaining <= 2:
            progress_hint += (
                "\n⚠️ 轮次即将用尽，请根据已收集信息调用 submit_result 提交结论，不要再抓取新页面。"
            )
        elif remaining <= 4:
            progress_hint += "\n💡 轮次剩余不多，请评估是否已有足够信息，适时调用 submit_result。"

        # 改进 C：token 压力检测（参照 OpenClaw Context Budget 机制）
        # 用 estimate_chars 估算当前 context 占比，>70% 时注入额外警告
        token_pressure = estimate_chars(messages) / (CHARS_PER_TOKEN * CONTEXT_WINDOW_TOKENS)
        if token_pressure > 0.70:
            pressure_pct = int(token_pressure * 100)
            progress_hint += (
                f"\n🔴 上下文已用 {pressure_pct}%（即将溢出），"
                "请立即调用 submit_result 提交目前收集到的结论，不要再抓取新内容。"
            )
            print(f"[executor] token pressure {pressure_pct}% at turn {turn+1}, injecting warning")

        messages[0] = {"role": "system", "content": base_system + progress_hint}

        resp = call_ai(messages, tools=executor_tools)
        msg = resp["choices"][0]["message"]
        messages.append(msg)

        tc_list = msg.get("tool_calls") or []
        content = msg.get("content", "")
        if content:
            collected_outputs.append(content)

        tm.append_assistant(
            turn=turn + 1,
            content=content,
            tool_calls=[{"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]} for tc in tc_list],
        )

        if not tc_list:
            # Executor 输出最终结果
            return {
                "ok": True,
                "output": content,
                "tool_calls_log": tool_calls_log,
                "turns": turn + 1,
            }

        for tc in tc_list:
            t_name = tc["function"]["name"]
            t_args = json.loads(tc["function"]["arguments"])

            # 改进 B：拦截 submit_result（参照 OpenClaw update_goal(complete)）
            # AI 主动调用 submit_result → 立即结束，不再继续循环
            if t_name == "submit_result":
                final_content = t_args.get("content", "").strip()
                if final_content:
                    tm.append_tool_call(
                        turn=turn + 1,
                        tool_name=t_name,
                        tool_input=t_args,
                        tool_output="[task completed by AI]",
                        tool_call_id=tc["id"],
                    )
                    print(f"[executor] submit_result called at turn {turn+1}, content_len={len(final_content)}")
                    return {
                        "ok": True,
                        "output": final_content,
                        "tool_calls_log": tool_calls_log,
                        "turns": turn + 1,
                    }
                # content 为空：忽略 submit_result，继续执行
                continue

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
        f"**Executor 实际输出**：\n{res.get('output', '')[:3000]}\n\n"
        f"**实际工具调用记录**（用于判断是否真正获取了数据）：\n"
        f"{json.dumps(res.get('tool_calls_log', []), ensure_ascii=False)}"
        for i, (tc, res) in enumerate(zip(test_cases, executor_results))
    ])

    user_content = (
        f"## SKILL.md\n\n{skill_md[:3000]}\n\n"
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
        - 使用 invoke_skill 工具，把 SKILL.md 全文作为 skill_system_prompt，
          把每个测试用例作为 user_message，直接调用 Skill
        - invoke_skill 会以 Skill 的身份回答，返回真实的 Skill 输出
        - 每个测试用例调用一次 invoke_skill

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

    user_msg = f"""
## SKILL.md 内容
{SKILL_MD}

## 测试输入
{json.dumps(USER_INPUTS, ensure_ascii=False, indent=2)}

请开始测试这个 Skill。
    """.strip()

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
        if skill_type in ("mcp", "script"):
            # ── 双 Agent 路径：Executor + Evaluator ──────────────────────────
            # 创建 TranscriptManager
            tm = TranscriptManager(
                work_dir="/tmp/transcript",
                skill_id=SKILL_ID,
                context_tokens=CONTEXT_WINDOW_TOKENS,
            )
            tm.append_event("start", f"双 Agent 模式，skill_type={skill_type}")

            # 解析测试用例
            if isinstance(USER_INPUTS, dict):
                test_cases = list(USER_INPUTS.values())
            elif isinstance(USER_INPUTS, list):
                test_cases = USER_INPUTS
            else:
                test_cases = [str(USER_INPUTS)]

            # Executor 依次执行每个测试用例
            executor_results = []
            for i, case in enumerate(test_cases):
                progress(f"执行用例 {i+1}/{len(test_cases)}", str(case)[:80])
                tm.append_event("executor_start", f"用例 {i+1}: {str(case)[:100]}")
                e_result = executor_react_loop(
                    skill_md=SKILL_MD,
                    user_message=str(case),
                    mcp_tools=mcp_native_tools,
                    tm=tm,
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
            output = json.dumps(eval_result, ensure_ascii=False)
            display_transcript = tm.get_display_entries()

            result = {
                "skill_id": SKILL_ID,
                "passed": eval_result.get("passed", False),
                "output": output,
                "transcript": display_transcript,
                "testInput": json.dumps(USER_INPUTS, ensure_ascii=False),
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
                "testInput": json.dumps(USER_INPUTS, ensure_ascii=False),
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
