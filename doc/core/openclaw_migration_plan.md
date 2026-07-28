# OpenClaw React Loop 完整移植方案

> 基于完整读取 OpenClaw 源码后的分析，不是猜测。

---

## 第一部分：OpenClaw 架构全景（源码真实情况）

### 两层循环，职责完全不同

OpenClaw 有**两层嵌套循环**，我之前搞混了它们：

```
外层循环：run.ts 的 while(true)   ← MAX_RUN_LOOP_ITERATIONS 控制
    用途：处理 rate limit / timeout / compaction 失败后的重试
    不是 AI 工具调用的轮次！
    
内层循环：attempt.ts 的工具执行循环  ← 没有轮次硬限制
    用途：AI 返回 tool_calls → 执行 → 喂回 → 再次调用 AI
    结束条件：AI 返回 stopReason = "end_turn" 或 "stop"（不调工具）
```

`MAX_RUN_LOOP_ITERATIONS` 默认值是根据 profile 数量计算的，是为了防止
网络/认证失败无限重试，**和工具调用轮数完全无关**。

### 单次 attempt 的完整生命周期

```
attempt.ts 的一次执行：

1. 构建 system prompt（含 contextBudgetStatus）
2. 检查 preemptive compaction（context > 50% → 先压缩）
3. 调用 LLM（流式/非流式）
4. 处理响应：
   ├─ 有 tool_calls → 执行所有工具 → 把结果 append 到 messages → 回到步骤 2
   ├─ stopReason = "end_turn" → 直接返回 assistantTexts 作为最终结果
   ├─ stopReason = "length" → 注入 REASONING_ONLY_RETRY_INSTRUCTION → 回到步骤 3
   ├─ 空响应（reasoning only）→ 注入 EMPTY_RESPONSE_RETRY_INSTRUCTION → 回到步骤 3
   └─ 错误 → 外层 run.ts 的 while(true) 决定是否重试
```

### 我们的架构 vs OpenClaw

| 维度 | 我们 | OpenClaw |
|------|------|----------|
| 工具调用循环 | `for turn in range(12)` | `while True`（内层，无限） |
| 结束信号 | `not tc_list` → return（已被我删掉）| `stopReason = "end_turn"` |
| 截断处理 | 无 | 检测 `stopReason = "length"`，注入 recovery |
| Context 压力 | 注入文字警告 | 真正压缩 tool result（truncate_tool_results_only） |
| 重试机制 | 无 | 外层 while(true) + rate limit/timeout 重试 |
| 轮次限制 | 12 轮硬限 | 无轮次限制，只有 context budget |


---

## 第二部分：Preemptive Compaction 完整机制

### OpenClaw 的 4 条路由（preemptive-compaction.ts）

每次调 LLM 前，先估算 context 压力，选一条路：

- `fits` → 直接调，不处理（overflow = 0）
- `truncate_tool_results_only` → 只截短旧 tool results（overflow 小）
- `compact_then_truncate` → LLM 摘要 + 截 tool results（overflow 大）
- `compact_only` → 只做 LLM 摘要（没有可截的 tool results）

关键触发条件：`toolResultReducibleChars >= overflow * 1.5` 才走截短路由。

### 关键常量（源码实测值）

```
ESTIMATED_CHARS_PER_TOKEN = 4    # 普通文字
TOOL_RESULT_CHARS_PER_TOKEN = 2  # tool result 更保守
MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12
MIN_PROMPT_BUDGET_TOKENS = 8000
MIN_PROMPT_BUDGET_RATIO = 0.5
SAFETY_MARGIN = 1.1              # 估算时乘以安全系数
```

### 需要移植的 Python 版本

```python
def should_compact(messages, system_prompt, context_window_tokens, reserve=4096):
    CHARS_PER_TOKEN, SAFETY = 4, 1.1
    total_chars = sum(len(str(m.get("content",""))) for m in messages)
    total_chars += len(system_prompt)
    estimated_tokens = int(total_chars / CHARS_PER_TOKEN * SAFETY)
    budget = context_window_tokens - reserve
    overflow = max(0, estimated_tokens - budget)
    if overflow == 0:
        return "fits"
    tool_chars = sum(len(m.get("content","")) for m in messages if m["role"]=="tool")
    if tool_chars * 0.7 >= overflow * CHARS_PER_TOKEN * 1.5:
        return "truncate"
    return "compact"

def truncate_tool_results(messages, keep_recent=3, max_chars=2000):
    tool_indices = [i for i,m in enumerate(messages) if m["role"]=="tool"]
    for idx in tool_indices[:-keep_recent]:
        c = messages[idx].get("content","")
        if len(c) > max_chars:
            messages[idx] = {**messages[idx],
                "content": c[:max_chars] + "\n...[compacted]"}
    return messages
```


---

## 第三部分：Incomplete Turn 处理

### OpenClaw 区分的情况（incomplete-turn.ts）

```typescript
// 这 2 种情况判定为"不完整"，需要继续：
stopReason === "toolUse"
  // 或
stopReason === "length" && !hasTerminalOutput
```

其他情况（`end_turn`、`stop`）= 完整，直接返回结果。

### 两种 Recovery Instruction（作为 user 消息注入，不修改 system prompt）

```
REASONING_ONLY_RETRY_INSTRUCTION（AI 有 thinking 但没有可见文字）:
  "The previous assistant turn recorded reasoning but did not produce a
   user-visible answer. Continue from that partial turn and produce the
   visible answer now. Do not restate the reasoning or restart from scratch."

EMPTY_RESPONSE_RETRY_INSTRUCTION（AI 完全空响应）:
  "The previous attempt did not produce a user-visible answer.
   Continue from the current state and produce the visible answer now.
   Do not restart from scratch."
```

### 需要移植的 Python 版本

```python
RECOVERY_TRUNCATED = (
    "你上一条回复被截断了（达到 token 上限）。"
    "请从截断处继续，完成完整回复，不要从头重写。"
)
RECOVERY_EMPTY = (
    "你没有输出任何内容。请继续完成任务，不要重新开始。"
)

def handle_no_tool_calls(content, finish_reason, messages):
    """
    参照 OpenClaw 的 isIncompleteTerminalAssistantTurn 逻辑。
    返回 (should_return, recovery_msg)
    """
    if finish_reason == "stop" or finish_reason == "end_turn":
        # 正常结束 → 直接返回结果
        return True, None
    elif finish_reason == "length":
        # 被截断 → 注入 recovery，继续
        return False, RECOVERY_TRUNCATED
    elif not content:
        # 空响应 → 注入 recovery，继续
        return False, RECOVERY_EMPTY
    else:
        # 有内容但没有工具调用，也是正常结束
        return True, None
```


---

## 第四部分：完整的移植后 executor_react_loop 结构

这是把 OpenClaw 三个核心机制移植到 Python 后的完整循环结构。
注意：这不是最终代码，是作为参照的伪代码。

```python
def executor_react_loop(skill_md, user_message, mcp_tools, tm,
                        max_turns=None):  # max_turns 改为软限，不是硬止
    CONTEXT_WINDOW = 256_000  # doubao-seed
    RESERVE_TOKENS = 8_000    # 留给输出的空间
    HARD_TURN_LIMIT = 30      # 防止失控的安全阀（不是正常结束条件）

    system = build_system_prompt(skill_md)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_message},
    ]
    tool_calls_log = []
    turn = 0

    while turn < HARD_TURN_LIMIT:
        turn += 1

        # Step 1: Preemptive Compaction（参照 OpenClaw）
        route = should_compact(messages, system, CONTEXT_WINDOW, RESERVE_TOKENS)
        if route == "truncate":
            messages = truncate_tool_results(messages)
            # 记录日志：[executor] compaction route=truncate at turn {turn}
        elif route == "compact":
            # 暂不实现 LLM 摘要压缩，只截短
            messages = truncate_tool_results(messages, max_chars=1000)

        # Step 2: 调用 LLM
        resp = call_ai(messages, tools=executor_tools)
        msg = resp["choices"][0]["message"]
        finish_reason = resp["choices"][0].get("finish_reason", "stop")
        messages.append(msg)

        tc_list = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip()

        # Step 3: 处理响应（参照 OpenClaw incomplete-turn.ts）
        if not tc_list:
            should_return, recovery = handle_no_tool_calls(
                content, finish_reason, messages
            )
            if should_return:
                # end_turn → 正常完成
                return {"ok": bool(content), "output": content,
                        "tool_calls_log": tool_calls_log, "turns": turn}
            else:
                # 截断 or 空响应 → 注入 recovery，继续
                messages.append({"role": "user", "content": recovery})
                continue

        # Step 4: 执行工具
        for tc in tc_list:
            t_name = tc["function"]["name"]
            t_args = json.loads(tc["function"]["arguments"])
            result = dispatch_tool(t_name, t_args)
            tool_calls_log.append(...)
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": result})

    # 达到安全阀上限（不正常）
    return {"ok": False, "output": "达到轮次安全阀", "turns": turn}
```

---

## 第五部分：移植优先级和测试方案

### 必须先做（修复现有 Bug）

1. **删除 `submit_result` 工具**：OpenClaw 没有这个，LLM 不会用
2. **恢复 `end_turn` 退出路径**：`if not tc_list: return ok=True`
3. **删除 system prompt 里的 `submit_result` 描述**

### 移植第一轮（核心机制，可测试）

4. **区分 `finish_reason`**：`stop` → 返回，`length` → recovery 提示继续
5. **把 `for range(12)` 改成 `while + HARD_TURN_LIMIT=30`**：更接近 OpenClaw
6. **移植 `truncate_tool_results`**：context > 60% 时截短旧 tool results

### 移植第二轮（优化）

7. **精确的 token 估算**：参照 OpenClaw 的 TOOL_RESULT_CHARS_PER_TOKEN=2
8. **进度信息改为中立描述**：不再威胁"警告"，只展示状态

### 测试方案

每次改动后：
1. 本地语法检查：`python3 -m py_compile runner.py`
2. 提交 + build + deploy
3. 跑 sandbox job 看日志：
   - 观察 `finish_reason`（是 `stop` 还是 `length`）
   - 观察 turns 是否减少（正常 5-8 轮就该完成）
   - 观察 `ok=True` 是否出现

