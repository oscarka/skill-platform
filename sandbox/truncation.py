"""
sandbox/truncation.py — OpenClaw 风格的智能截断模块

参照 OpenClaw tool-result-truncation.ts (1400行) 实现核心逻辑：
1. has_important_tail — 检测尾部是否有重要内容（错误/JSON/结论）
2. truncate_tool_result — 头+尾保留策略（OpenClaw 核心创新）
3. calculate_max_chars — 根据 context window 动态计算截断上限
4. truncate_messages_aggregate — 全局消息级别截断（budget 分配）
"""
import re
from typing import Optional

# ─── 常量（对标 OpenClaw） ────────────────────────────────────────────────────
# 单个 tool result 最大占 context 的 30%
MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3

# 不同 context window 下的单条 tool result 上限
DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000      # <=100k tokens
LARGE_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS = 32_000  # 100k-200k tokens
XL_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS = 64_000     # >200k tokens

# 全部 tool results 合计最多占 context 的 50%
AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.5
AGGREGATE_CAP_MULTIPLIER = 4

# 截断时最少保留字符数
MIN_KEEP_CHARS = 2_000

# 中间省略标记
MIDDLE_OMISSION_MARKER = "\n\n[... content omitted ...]\n\n"

# 截断后缀模板
def truncation_suffix(truncated_chars: int) -> str:
    return f"\n[... {max(1, truncated_chars)} chars truncated; rerun with narrower args if needed]"

# 聚合省略标记
AGGREGATE_ELISION_MARKER = "[tool result elided: aggregate tool-result budget exceeded; rerun the command if the output is needed]"


# ─── 核心：检测尾部是否包含重要内容 ──────────────────────────────────────────
def has_important_tail(text: str) -> bool:
    """
    参照 OpenClaw hasImportantTail：
    检查末尾 2000 字符是否包含错误信息、JSON 结构、总结等。
    如果有，截断时应保留尾部。
    """
    tail = text[-2000:].lower() if len(text) > 2000 else text.lower()

    # 错误类关键词
    error_pattern = re.compile(
        r'\b(error|exception|failed|fatal|traceback|panic|stack.?trace|errno|exit.?code)\b'
    )
    if error_pattern.search(tail):
        return True

    # JSON 闭合结构
    if re.search(r'}\s*$', tail.strip()):
        return True

    # 总结/结果类关键词
    summary_pattern = re.compile(
        r'\b(total|summary|result|complete|finished|done|conclusion|结论|总结|结果)\b'
    )
    if summary_pattern.search(tail):
        return True

    return False


# ─── 核心：智能截断单条 tool output ──────────────────────────────────────────
def truncate_tool_result(
    text: str,
    max_chars: int,
    min_keep: int = MIN_KEEP_CHARS,
    suffix_fn=None,
) -> str:
    """
    参照 OpenClaw truncateToolResultText：
    - 如果尾部有重要内容 → 头部 70% + 尾部 30%（保留错误信息和结论）
    - 否则 → 只保留头部
    - 在换行符边界切割（避免截断到半行）
    """
    if suffix_fn is None:
        suffix_fn = truncation_suffix

    if len(text) <= max_chars:
        return text

    default_suffix = suffix_fn(max(1, len(text) - max_chars))
    budget = max(min_keep, max_chars - len(default_suffix))

    # 策略 1：头+尾保留（OpenClaw 核心创新）
    if has_important_tail(text) and budget > min_keep * 2:
        tail_budget = min(int(budget * 0.3), 4_000)
        head_budget = budget - tail_budget - len(MIDDLE_OMISSION_MARKER)

        if head_budget > min_keep:
            # 在换行符边界切割
            head_cut = head_budget
            head_newline = text.rfind("\n", 0, head_budget)
            if head_newline > head_budget * 0.8:
                head_cut = head_newline

            tail_start = len(text) - tail_budget
            tail_newline = text.find("\n", tail_start)
            if tail_newline != -1 and tail_newline < tail_start + int(tail_budget * 0.2):
                tail_start = tail_newline + 1

            kept = text[:head_cut] + MIDDLE_OMISSION_MARKER + text[tail_start:]
            # 加截断后缀
            if len(kept) > max_chars:
                kept = kept[:max_chars - len(default_suffix)]
            return kept + default_suffix

    # 策略 2：只保留头部
    cut_point = budget
    last_newline = text.rfind("\n", 0, budget)
    if last_newline > budget * 0.8:
        cut_point = last_newline

    return text[:cut_point] + default_suffix


# ─── 根据 context window 动态计算单条 tool result 上限 ────────────────────────
def calculate_max_chars(context_window_tokens: int) -> int:
    """
    参照 OpenClaw calculateMaxToolResultChars：
    context window 越大，允许的单条 tool result 越长。
    粗略换算：4 chars ≈ 1 token
    """
    auto_cap = resolve_auto_live_max_chars(context_window_tokens)
    raw = int(context_window_tokens * 4 * MAX_TOOL_RESULT_CONTEXT_SHARE)
    return min(raw, auto_cap)


def resolve_auto_live_max_chars(context_window_tokens: int) -> int:
    """参照 OpenClaw resolveAutoLiveToolResultMaxChars"""
    if context_window_tokens >= 200_000:
        return XL_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS
    if context_window_tokens >= 100_000:
        return LARGE_CONTEXT_MAX_LIVE_TOOL_RESULT_CHARS
    return DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS


def calculate_aggregate_max_chars(context_window_tokens: int) -> int:
    """所有 tool results 的总预算"""
    per_result = calculate_max_chars(context_window_tokens)
    raw = int(context_window_tokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE)
    return min(raw, per_result * AGGREGATE_CAP_MULTIPLIER)


# ─── 聚合截断：对整个 messages 数组里的 tool results 做预算分配 ────────────────
def truncate_messages_aggregate(
    messages: list,
    context_window_tokens: int = 128_000,
) -> list:
    """
    参照 OpenClaw truncateOversizedToolResultsInMessages：
    1. 先对单条超标的 tool result 做截断
    2. 再检查总量是否超 aggregate budget，如果超了从最旧的开始 elide
    """
    per_max = calculate_max_chars(context_window_tokens)
    agg_max = calculate_aggregate_max_chars(context_window_tokens)

    result = []
    total_tool_chars = 0

    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > per_max:
                # 单条截断
                content = truncate_tool_result(content, per_max)
            total_tool_chars += len(content) if isinstance(content, str) else 0
            result.append({**msg, "content": content})
        else:
            result.append(msg)

    # 如果总量超标，从最旧的 tool result 开始 elide
    if total_tool_chars > agg_max:
        excess = total_tool_chars - agg_max
        for i, msg in enumerate(result):
            if excess <= 0:
                break
            if msg.get("role") == "tool":
                old_len = len(msg.get("content", ""))
                if old_len > MIN_KEEP_CHARS:
                    result[i] = {**msg, "content": AGGREGATE_ELISION_MARKER}
                    excess -= (old_len - len(AGGREGATE_ELISION_MARKER))

    return result
