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
    两阶段截断计划：
    1. buildOversizedToolResultReplacements — 单条超标的先截断
    2. buildAggregateToolResultReplacements — 总量超标的从旧到新 elide
    保护最近的 tool result 不被 elide（OpenClaw getTrailingToolResultEntryIds）
    """
    per_max = calculate_max_chars(context_window_tokens)
    agg_max = calculate_aggregate_max_chars(context_window_tokens)

    # ─── Phase 1: 单条超标截断 ────────────────────────────────────────────
    phase1 = []
    oversized_count = 0
    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > per_max:
                content = truncate_tool_result(content, per_max)
                oversized_count += 1
            phase1.append({**msg, "content": content})
        else:
            phase1.append(msg)

    # ─── Phase 2: 聚合预算检查 ────────────────────────────────────────────
    total_tool_chars = sum(
        len(m.get("content", "")) for m in phase1
        if m.get("role") == "tool" and isinstance(m.get("content"), str)
    )

    if total_tool_chars <= agg_max:
        return phase1

    # 找到最后一批连续的 tool results（保护它们不被 elide）
    protected_indices = _get_trailing_tool_indices(phase1)

    # 按从旧到新的顺序尝试截断
    excess = total_tool_chars - agg_max
    aggregate_count = 0

    # Pass 2a: 先截断非保护的 tool results
    for i, msg in enumerate(phase1):
        if excess <= 0:
            break
        if msg.get("role") != "tool" or i in protected_indices:
            continue
        content = msg.get("content", "")
        if not isinstance(content, str) or len(content) <= MIN_KEEP_CHARS:
            continue

        # 尝试截断到 MIN_KEEP_CHARS
        old_len = len(content)
        target = max(MIN_KEEP_CHARS, old_len - excess)
        if target < old_len:
            new_content = truncate_tool_result(content, target)
            actual_reduction = old_len - len(new_content)
            if actual_reduction > 0:
                phase1[i] = {**msg, "content": new_content}
                excess -= actual_reduction
                aggregate_count += 1

    # Pass 2b: 如果还不够，完全 elide 最旧的（仍跳过保护的）
    if excess > 0:
        for i, msg in enumerate(phase1):
            if excess <= 0:
                break
            if msg.get("role") != "tool" or i in protected_indices:
                continue
            content = msg.get("content", "")
            if not isinstance(content, str):
                continue
            old_len = len(content)
            if old_len <= len(AGGREGATE_ELISION_MARKER):
                continue

            # 带 spill 路径的用特殊 marker
            spill = msg.get("_spill_path")
            if spill:
                marker = f"[tool result elided: full output at {spill}; read it if needed]"
            else:
                marker = AGGREGATE_ELISION_MARKER

            phase1[i] = {**msg, "content": marker}
            excess -= (old_len - len(marker))
            aggregate_count += 1

    # Pass 2c: 万不得已，连保护的也截断（但不完全 elide）
    if excess > 0:
        for i in sorted(protected_indices):
            if excess <= 0:
                break
            msg = phase1[i]
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > MIN_KEEP_CHARS:
                old_len = len(content)
                target = max(MIN_KEEP_CHARS, old_len - excess)
                new_content = truncate_tool_result(content, target)
                actual_reduction = old_len - len(new_content)
                if actual_reduction > 0:
                    phase1[i] = {**msg, "content": new_content}
                    excess -= actual_reduction

    return phase1


def _get_trailing_tool_indices(messages: list) -> set:
    """
    参照 OpenClaw getTrailingToolResultEntryIds：
    找到消息数组末尾连续的 tool result 索引集合。
    这些是最新的工具调用结果，应该优先保护。
    """
    indices = set()
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") == "tool":
            indices.add(i)
        elif msg.get("role") == "assistant":
            # assistant 和其 tool results 是一组，继续向前找
            continue
        else:
            break
    return indices


# ─── 估算截断潜力（诊断用）─────────────────────────────────────────────────
def estimate_reduction_potential(
    messages: list,
    context_window_tokens: int = 128_000,
) -> dict:
    """
    参照 OpenClaw estimateToolResultReductionPotential：
    估算如果做截断能释放多少空间，用于诊断和日志。
    """
    per_max = calculate_max_chars(context_window_tokens)
    agg_max = calculate_aggregate_max_chars(context_window_tokens)

    total_tool_chars = 0
    oversized_reducible = 0
    tool_count = 0

    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if isinstance(content, str):
                length = len(content)
                total_tool_chars += length
                tool_count += 1
                if length > per_max:
                    oversized_reducible += (length - per_max)

    aggregate_excess = max(0, total_tool_chars - agg_max)

    return {
        "total_tool_chars": total_tool_chars,
        "tool_count": tool_count,
        "per_max_chars": per_max,
        "aggregate_max_chars": agg_max,
        "oversized_reducible_chars": oversized_reducible,
        "aggregate_excess_chars": aggregate_excess,
        "total_reducible_chars": oversized_reducible + aggregate_excess,
        "needs_truncation": oversized_reducible > 0 or aggregate_excess > 0,
    }


# ─── Compact Recovery 模式（上下文溢出时的激进截断）──────────────────────────
COMPACT_RECOVERY_SUFFIX = lambda chars: f"[... {max(1, chars)} chars truncated; narrow args]"


def truncate_for_recovery(
    text: str,
    max_chars: int,
) -> str:
    """
    参照 OpenClaw recovery 模式：
    比普通截断更激进 — min_keep_chars=0，使用更短的后缀。
    用于 context window 溢出后的紧急恢复。
    """
    return truncate_tool_result(
        text,
        max_chars,
        min_keep=0,
        suffix_fn=COMPACT_RECOVERY_SUFFIX,
    )


def truncate_messages_recovery(
    messages: list,
    context_window_tokens: int = 128_000,
) -> list:
    """
    参照 OpenClaw compact_then_truncate 策略：
    溢出恢复模式 — 用更激进的截断参数。
    """
    per_max = calculate_max_chars(context_window_tokens) // 2  # 恢复时预算减半
    agg_max = calculate_aggregate_max_chars(context_window_tokens) // 2

    result = []
    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > per_max:
                content = truncate_for_recovery(content, per_max)
            result.append({**msg, "content": content})
        else:
            result.append(msg)

    # 聚合截断（保护尾部）
    total = sum(len(m.get("content", "")) for m in result if m.get("role") == "tool" and isinstance(m.get("content"), str))
    if total > agg_max:
        protected = _get_trailing_tool_indices(result)
        excess = total - agg_max
        for i, msg in enumerate(result):
            if excess <= 0:
                break
            if msg.get("role") == "tool" and i not in protected:
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) > 0:
                    result[i] = {**msg, "content": AGGREGATE_ELISION_MARKER}
                    excess -= (len(content) - len(AGGREGATE_ELISION_MARKER))

    return result


# ─── 上下文大小估算 ────────────────────────────────────────────────────────
def estimate_context_chars(messages: list) -> int:
    """估算整个 messages 数组的总字符数"""
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total += len(content)
        # tool_calls 里的 arguments 也算
        for tc in msg.get("tool_calls", []):
            fn = tc.get("function", {})
            total += len(fn.get("arguments", ""))
    return total


def context_pressure_check(
    messages: list,
    context_window_tokens: int = 128_000,
) -> dict:
    """
    参照 OpenClaw precheck recovery：
    检测当前 context 是否接近上限，返回压力信息。
    """
    total_chars = estimate_context_chars(messages)
    # 粗略：4 chars ≈ 1 token
    estimated_tokens = total_chars // 4
    pressure_ratio = estimated_tokens / context_window_tokens if context_window_tokens > 0 else 0

    return {
        "total_chars": total_chars,
        "estimated_tokens": estimated_tokens,
        "context_window_tokens": context_window_tokens,
        "pressure_ratio": round(pressure_ratio, 3),
        "warning": pressure_ratio > 0.7,
        "critical": pressure_ratio > 0.9,
        "action": (
            "recovery" if pressure_ratio > 0.9
            else "truncate" if pressure_ratio > 0.7
            else "none"
        ),
    }
