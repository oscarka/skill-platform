"""
sandbox/redact.py — 敏感信息脱敏模块

参照 OpenClaw transcript-redact.ts (692行) 的核心功能实现：
1. redact_secrets — 检测并替换 API key / token / password
2. redact_message — 对单条消息做脱敏
3. redact_env_vars — 从 env dump 里脱敏
"""
import re
from typing import Any

# ─── 脱敏模式 ─────────────────────────────────────────────────────────────────
# API Key 模式（常见格式：sk-xxx, Bearer xxx, key=xxx）
_SECRET_PATTERNS = [
    # OpenAI / Doubao / DeepSeek 风格 key
    (re.compile(r'(sk-[a-zA-Z0-9]{20,})', re.I), r'sk-***REDACTED***'),
    # Bearer token
    (re.compile(r'(Bearer\s+)[a-zA-Z0-9_\-\.]{20,}', re.I), r'\1***REDACTED***'),
    # Authorization header value
    (re.compile(r'(Authorization["\s:=]+)[^\s"]{20,}', re.I), r'\1***REDACTED***'),
    # API key in URL params
    (re.compile(r'([?&](?:api[_-]?key|token|secret|password|key)=)[^\s&"]{8,}', re.I), r'\1***REDACTED***'),
    # JSON 里的 key 字段
    (re.compile(r'("(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|private[_-]?key|refresh[_-]?token)":\s*")[^"]{8,}(")', re.I), r'\1***REDACTED***\2'),
    # 环境变量赋值
    (re.compile(r'((?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*)[^\s]{8,}', re.I), r'\1***REDACTED***'),
    # base64 编码的长字符串（可能是 key）
    (re.compile(r'(eyJ[a-zA-Z0-9_\-]{50,})', re.I), r'***JWT_REDACTED***'),
]


def redact_secrets(text: str) -> str:
    """
    参照 OpenClaw redactSecrets：
    替换文本中的各类敏感信息。
    """
    if not text or not isinstance(text, str):
        return text

    result = text
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)

    return result


def redact_message(msg: dict) -> dict:
    """
    参照 OpenClaw redactTranscriptMessage：
    对单条 transcript 消息做脱敏。
    递归处理 content / input / output / args 等字段。
    """
    if not isinstance(msg, dict):
        return msg

    redacted = {}
    for key, value in msg.items():
        if isinstance(value, str):
            redacted[key] = redact_secrets(value)
        elif isinstance(value, dict):
            redacted[key] = redact_message(value)
        elif isinstance(value, list):
            redacted[key] = [
                redact_message(item) if isinstance(item, dict)
                else redact_secrets(item) if isinstance(item, str)
                else item
                for item in value
            ]
        else:
            redacted[key] = value

    return redacted


def redact_env_vars(env: dict) -> dict:
    """对环境变量 dict 做脱敏（隐藏值）"""
    sensitive_keys = {
        'API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PRIVATE_KEY',
        'AI_API_KEY', 'SANDBOX_SECRET', 'DATABASE_URL',
        'FALLBACK_AI_API_KEY', 'GOOGLE_CLIENT_SECRET',
    }
    result = {}
    for k, v in env.items():
        if any(s in k.upper() for s in sensitive_keys):
            result[k] = '***REDACTED***' if v else ''
        else:
            result[k] = v
    return result
