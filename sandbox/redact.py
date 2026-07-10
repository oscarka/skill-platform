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


# ─── 结构化字段脱敏（参照 OpenClaw redactTranscriptStructuredFieldValue）──────
# 某些字段名暗示值是敏感的，即使正则没匹配到也要脱敏
_SENSITIVE_FIELD_NAMES = re.compile(
    r'(?i)(api[_-]?key|access[_-]?token|secret[_-]?key|password|private[_-]?key|'
    r'refresh[_-]?token|client[_-]?secret|auth[_-]?token|bearer|credential|'
    r'session[_-]?id|cookie|csrf|x[_-]auth)'
)


def redact_structured_field(key: str, value: str) -> str:
    """
    参照 OpenClaw redactSensitiveFieldValue：
    根据字段名判断是否应该脱敏。
    """
    if not isinstance(value, str) or len(value) < 8:
        return value
    if _SENSITIVE_FIELD_NAMES.search(key):
        # 保留前4个字符用于调试识别
        if len(value) > 12:
            return value[:4] + '***REDACTED***'
        return '***REDACTED***'
    return redact_secrets(value)


def redact_message_structured(msg: dict) -> dict:
    """
    增强版：对消息里的每个字段使用结构化脱敏。
    比 redact_message 多一层——根据字段名称来判断是否脱敏。
    """
    if not isinstance(msg, dict):
        return msg

    redacted = {}
    for key, value in msg.items():
        if isinstance(value, str):
            redacted[key] = redact_structured_field(key, value)
        elif isinstance(value, dict):
            redacted[key] = redact_message_structured(value)
        elif isinstance(value, list):
            redacted[key] = [
                redact_message_structured(item) if isinstance(item, dict)
                else redact_structured_field(key, item) if isinstance(item, str)
                else item
                for item in value
            ]
        else:
            redacted[key] = value

    return redacted


# ─── Base64 图片数据脱敏（参照 OpenClaw sanitizeImageRecord）──────────────────

_BASE64_LONG_PATTERN = re.compile(r'^[A-Za-z0-9+/=]{100,}$')
_DATA_URL_PATTERN = re.compile(r'^data:image/[a-z]+;base64,(.+)', re.I)


def sanitize_base64_image(text: str) -> str:
    """
    参照 OpenClaw sanitizeOpaqueImageBase64：
    如果文本是 base64 图片数据，替换为占位符（保留 MIME type）。
    """
    # data:image/png;base64,xxxxx
    m = _DATA_URL_PATTERN.match(text)
    if m:
        return f"data:image/[redacted];base64,[{len(m.group(1))} chars of base64 data]"

    # 纯 base64（>100 字符的长串）
    if _BASE64_LONG_PATTERN.match(text) and len(text) > 200:
        return f"[base64 data: {len(text)} chars]"

    return text


# ─── URL 里的凭证脱敏 ────────────────────────────────────────────────────────

_URL_CRED_PATTERN = re.compile(
    r'(https?://)([^:]+):([^@]+)@', re.I
)


def redact_url_credentials(text: str) -> str:
    """
    参照 OpenClaw URL redaction：
    脱敏 URL 里的 user:password@host 格式凭证。
    """
    return _URL_CRED_PATTERN.sub(r'\1\2:***@', text)


# ─── 完整脱敏管线（组合所有策略）──────────────────────────────────────────────

def redact_full(text: str) -> str:
    """
    完整脱敏管线：按顺序应用所有脱敏策略。
    比 redact_secrets 更全面。
    """
    if not text or not isinstance(text, str):
        return text
    result = text
    result = redact_secrets(result)        # API keys / tokens
    result = redact_url_credentials(result) # URL 凭证
    result = sanitize_base64_image(result)  # Base64 图片
    return result


def redact_message_full(msg: dict) -> dict:
    """
    完整消息脱敏：结构化字段 + 全文脱敏 + 图片处理。
    参照 OpenClaw redactTranscriptMessage 的完整流程。
    """
    if not isinstance(msg, dict):
        return msg

    redacted = {}
    for key, value in msg.items():
        if isinstance(value, str):
            # 先用结构化字段脱敏，再用全文脱敏
            v = redact_structured_field(key, value)
            v = redact_url_credentials(v)
            v = sanitize_base64_image(v)
            redacted[key] = v
        elif isinstance(value, dict):
            redacted[key] = redact_message_full(value)
        elif isinstance(value, list):
            redacted[key] = [
                redact_message_full(item) if isinstance(item, dict)
                else redact_full(item) if isinstance(item, str)
                else item
                for item in value
            ]
        else:
            redacted[key] = value

    return redacted


# ─── 自定义脱敏模式（参照 OpenClaw configurable patterns）──────────────────────

class RedactConfig:
    """
    可配置的脱敏策略。
    参照 OpenClaw readLoggingConfig + redactTranscriptOptions。
    """
    def __init__(self, extra_patterns: list = None, disabled: bool = False):
        self.disabled = disabled
        self.extra_patterns = []
        if extra_patterns:
            for p in extra_patterns:
                try:
                    self.extra_patterns.append(
                        (re.compile(p, re.I), '***CUSTOM_REDACTED***')
                    )
                except re.error:
                    pass

    def redact(self, text: str) -> str:
        if self.disabled or not text:
            return text
        result = redact_full(text)
        for pattern, replacement in self.extra_patterns:
            result = pattern.sub(replacement, result)
        return result

    def redact_message(self, msg: dict) -> dict:
        if self.disabled:
            return msg
        # 先用完整脱敏，再用自定义 pattern
        result = redact_message_full(msg)
        if self.extra_patterns:
            result = self._apply_extra(result)
        return result

    def _apply_extra(self, obj):
        if isinstance(obj, str):
            for pattern, replacement in self.extra_patterns:
                obj = pattern.sub(replacement, obj)
            return obj
        elif isinstance(obj, dict):
            return {k: self._apply_extra(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._apply_extra(item) for item in obj]
        return obj

