"""
sandbox/transcript.py — OpenClaw 风格的 Transcript 管理器

参照 OpenClaw transcript-append.ts + transcript-jsonl.ts + transcripts/store.ts：
1. TranscriptManager — 双文件 JSONL 存储
   - transcript_full.jsonl  → 完整记录（debug 用）
   - transcript.jsonl       → 截断版（UI 展示用，大内容标记 is_truncated）
2. append_message — 追加消息时自动脱敏 + 截断
3. get_display_entries — 获取截断版
4. get_full_entries — 获取完整版
5. upload_to_gcs — 上传到 GCS 持久化
6. spill_large_output — 大输出落盘到独立文件
"""
import json
import os
import time
import uuid
from typing import Optional, List, Any
from truncation import truncate_tool_result, calculate_max_chars, MIN_KEEP_CHARS
from redact import redact_message, redact_secrets, redact_message_full

# ─── 常量 ─────────────────────────────────────────────────────────────────────
# 参照 OpenClaw SESSION_MANAGER_APPEND_MAX_BYTES = 8MB
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

# 截断版中单条内容的上限
DISPLAY_CONTENT_MAX_CHARS = 4_000    # AI 回复
DISPLAY_OUTPUT_MAX_CHARS = 2_000     # Tool 输出
DISPLAY_INPUT_MAX_CHARS = 1_000      # Tool 输入

# 完整版中单条内容的上限（只对极端大的做限制）
FULL_CONTENT_MAX_CHARS = 100_000

# 大文件落盘阈值（超过这个值的 tool output 存独立文件）
SPILL_THRESHOLD_CHARS = 50_000


class TranscriptManager:
    """
    双份 JSONL Transcript 管理器。
    
    参照 OpenClaw 的 transcript.jsonl（截断版）+ transcript_full.jsonl（完整版）模式。
    """

    def __init__(self, work_dir: str = "/tmp", skill_id: str = "", context_tokens: int = 128_000):
        self.work_dir = work_dir
        self.skill_id = skill_id
        self.context_tokens = context_tokens

        # 双文件路径
        self.full_path = os.path.join(work_dir, "transcript_full.jsonl")
        self.display_path = os.path.join(work_dir, "transcript.jsonl")

        # 溢出文件目录
        self.spill_dir = os.path.join(work_dir, "spill")
        os.makedirs(self.spill_dir, exist_ok=True)

        # 内存缓存
        self._full_entries: List[dict] = []
        self._display_entries: List[dict] = []
        self._total_bytes = 0
        self._entry_count = 0

        # 写入 header
        header = {
            "type": "header",
            "version": 1,
            "skill_id": skill_id,
            "started_at": _now_iso(),
            "context_window_tokens": context_tokens,
        }
        self._append_raw(header, header)

    # ─── 追加消息 ────────────────────────────────────────────────────────────
    def append_assistant(self, turn: int, content: str, tool_calls: list = None) -> str:
        """追加 AI 助手回复"""
        entry_id = _gen_id()
        entry = {
            "type": "message",
            "id": entry_id,
            "turn": turn,
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls or [],
            "ts": _now_iso(),
        }
        # 完整版：脱敏但不截断（除非极端大）
        full_entry = redact_message_full(entry)
        if len(full_entry.get("content", "")) > FULL_CONTENT_MAX_CHARS:
            full_entry["content"] = full_entry["content"][:FULL_CONTENT_MAX_CHARS] + "...[full truncated]"

        # 截断版：脱敏 + 截断
        display_entry = dict(full_entry)
        if len(display_entry.get("content", "")) > DISPLAY_CONTENT_MAX_CHARS:
            display_entry["content"] = display_entry["content"][:DISPLAY_CONTENT_MAX_CHARS] + "...[truncated]"
            display_entry["is_truncated"] = True

        self._append_raw(full_entry, display_entry)
        return entry_id

    def append_tool_call(self, turn: int, tool_name: str, tool_input: Any,
                         tool_output: str, exit_code: int = 0,
                         tool_call_id: str = "") -> str:
        """
        追加工具调用记录。
        
        大输出自动 spill 到独立文件（参照 OpenClaw fullOutputPath 模式）。
        """
        entry_id = _gen_id()
        input_str = json.dumps(tool_input, ensure_ascii=False) if not isinstance(tool_input, str) else tool_input

        # ─── 完整版处理 ───────────────────────────────────────────────────
        full_output = tool_output
        spill_path = None

        # 大输出落盘（OpenClaw fullOutputPath 模式）
        if len(tool_output) > SPILL_THRESHOLD_CHARS:
            spill_path = self._spill_output(entry_id, tool_output)
            # 完整版保留全部，但加 spill 标记
            full_output = tool_output[:FULL_CONTENT_MAX_CHARS]
            if len(tool_output) > FULL_CONTENT_MAX_CHARS:
                full_output += f"\n...[{len(tool_output) - FULL_CONTENT_MAX_CHARS} chars spilled to {spill_path}]"

        full_entry = redact_message_full({
            "type": "message",
            "id": entry_id,
            "turn": turn,
            "role": "tool",
            "tool": tool_name,
            "tool_call_id": tool_call_id,
            "input": input_str[:10_000],  # 输入最多 10KB（完整版）
            "output": full_output,
            "exit_code": exit_code,
            "ts": _now_iso(),
            **({"spill_path": spill_path} if spill_path else {}),
        })

        # ─── 截断版处理 ───────────────────────────────────────────────────
        # 使用 OpenClaw 风格智能截断
        max_chars = calculate_max_chars(self.context_tokens)
        display_output = truncate_tool_result(
            tool_output,
            min(max_chars, DISPLAY_OUTPUT_MAX_CHARS),
        )

        display_entry = redact_message_full({
            "type": "message",
            "id": entry_id,
            "turn": turn,
            "role": "tool",
            "tool": tool_name,
            "tool_call_id": tool_call_id,
            "input": input_str[:DISPLAY_INPUT_MAX_CHARS] + ("..." if len(input_str) > DISPLAY_INPUT_MAX_CHARS else ""),
            "output": display_output,
            "exit_code": exit_code,
            "is_truncated": len(tool_output) > DISPLAY_OUTPUT_MAX_CHARS,
            "original_length": len(tool_output),
            "ts": _now_iso(),
            **({"spill_path": spill_path} if spill_path else {}),
        })

        self._append_raw(full_entry, display_entry)
        return entry_id

    def append_event(self, event_type: str, detail: str) -> str:
        """追加系统事件（进度、错误等）"""
        entry_id = _gen_id()
        entry = {
            "type": "event",
            "id": entry_id,
            "event": event_type,
            "detail": detail[:2000],
            "ts": _now_iso(),
        }
        self._append_raw(entry, entry)
        return entry_id

    # ─── 获取 transcript ─────────────────────────────────────────────────────
    def get_display_entries(self) -> List[dict]:
        """获取截断版（给 UI 展示、callback 回传）"""
        return list(self._display_entries)

    def get_full_entries(self) -> List[dict]:
        """获取完整版（给 debug、GCS 存储）"""
        return list(self._full_entries)

    def get_display_messages(self) -> List[dict]:
        """只获取消息类型的截断版条目（排除 header/event）"""
        return [e for e in self._display_entries if e.get("type") == "message"]

    @property
    def entry_count(self) -> int:
        return self._entry_count

    @property
    def total_bytes(self) -> int:
        return self._total_bytes

    # ─── 序列化 ───────────────────────────────────────────────────────────────
    def to_display_json(self) -> str:
        """序列化截断版为 JSON 数组（给 callback）"""
        return json.dumps(self._display_entries, ensure_ascii=False)

    def to_full_jsonl(self) -> str:
        """序列化完整版为 JSONL"""
        return "\n".join(json.dumps(e, ensure_ascii=False) for e in self._full_entries) + "\n"

    # ─── 上传到 GCS ──────────────────────────────────────────────────────────
    def upload_to_gcs(self, bucket: str) -> dict:
        """
        上传双份 transcript + spill 文件到 GCS。
        返回 {full_path, display_path, spill_paths}
        """
        import subprocess

        prefix = f"gs://{bucket}/transcripts/{self.skill_id}/{int(time.time())}"
        paths = {}

        # 写入本地 JSONL 文件
        with open(self.full_path, "w") as f:
            f.write(self.to_full_jsonl())
        with open(self.display_path, "w") as f:
            f.write(json.dumps(self._display_entries, ensure_ascii=False))

        # 上传
        for name, local in [("transcript_full.jsonl", self.full_path), ("transcript.json", self.display_path)]:
            gcs_path = f"{prefix}/{name}"
            try:
                subprocess.run(
                    ["gcloud", "storage", "cp", local, gcs_path],
                    capture_output=True, timeout=30
                )
                paths[name] = gcs_path
            except Exception as e:
                print(f"[transcript] GCS upload failed for {name}: {e}", flush=True)

        # 上传 spill 文件
        spill_paths = []
        for f in os.listdir(self.spill_dir):
            local = os.path.join(self.spill_dir, f)
            gcs_path = f"{prefix}/spill/{f}"
            try:
                subprocess.run(
                    ["gcloud", "storage", "cp", local, gcs_path],
                    capture_output=True, timeout=30
                )
                spill_paths.append(gcs_path)
            except Exception:
                pass
        paths["spill"] = spill_paths

        return paths

    # ─── 内部方法 ─────────────────────────────────────────────────────────────
    def _append_raw(self, full_entry: dict, display_entry: dict):
        """追加到双份缓存 + 写入文件"""
        self._full_entries.append(full_entry)
        self._display_entries.append(display_entry)
        self._entry_count += 1

        # 写入文件
        full_line = json.dumps(full_entry, ensure_ascii=False) + "\n"
        display_line = json.dumps(display_entry, ensure_ascii=False) + "\n"
        self._total_bytes += len(full_line.encode("utf-8"))

        try:
            with open(self.full_path, "a") as f:
                f.write(full_line)
            with open(self.display_path, "a") as f:
                f.write(display_line)
        except Exception as e:
            print(f"[transcript] file write error: {e}", flush=True)

    def _spill_output(self, entry_id: str, content: str) -> str:
        """
        参照 OpenClaw writePrivateTempFile：
        大输出落盘到独立文件，transcript 里只存路径。
        """
        filename = f"spill-{entry_id[:8]}.log"
        path = os.path.join(self.spill_dir, filename)
        try:
            with open(path, "w") as f:
                f.write(content)
            print(f"[transcript] spilled {len(content)} chars to {path}", flush=True)
        except Exception as e:
            print(f"[transcript] spill error: {e}", flush=True)
            return ""
        return path


# ─── 工具函数 ─────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _gen_id() -> str:
    return str(uuid.uuid4())


# ─── Transcript 重写（参照 OpenClaw rewriteTranscriptEntriesInSessionManager）─
def rewrite_transcript_entries(
    entries: list,
    max_tool_output_chars: int = 2000,
    max_ai_content_chars: int = 4000,
) -> list:
    """
    参照 OpenClaw rewriteTranscriptEntriesInState：
    对已有 transcript 条目进行原地重写——截断旧的 tool output 和 AI 回复。
    用于 transcript 文件变得太大时的清理操作。
    不创建新条目，只修改现有条目的 content/output 字段。
    """
    from truncation import truncate_tool_result

    rewritten = []
    rewrite_count = 0

    for entry in entries:
        e = dict(entry)

        if e.get("role") == "tool" and isinstance(e.get("output"), str):
            output = e["output"]
            if len(output) > max_tool_output_chars:
                e["output"] = truncate_tool_result(output, max_tool_output_chars)
                e["is_truncated"] = True
                e["original_length"] = len(output)
                rewrite_count += 1

        if e.get("role") == "assistant" and isinstance(e.get("content"), str):
            content = e["content"]
            if len(content) > max_ai_content_chars:
                e["content"] = content[:max_ai_content_chars] + "...[rewritten]"
                e["is_truncated"] = True
                e["original_length"] = len(content)
                rewrite_count += 1

        rewritten.append(e)

    if rewrite_count > 0:
        print(f"[transcript] rewrote {rewrite_count} entries", flush=True)

    return rewritten


# ─── Compaction（参照 OpenClaw compactEmbeddedAgentSessionDirect）──────────────
def compact_transcript(
    entries: list,
    target_entries: int = 50,
) -> list:
    """
    参照 OpenClaw compact：
    当 transcript 条目太多时，对早期内容做压缩：
    1. 保留 header
    2. 保留最后 target_entries 条
    3. 中间的合并成一条 compaction summary
    """
    if len(entries) <= target_entries:
        return entries

    # header 永远保留
    header_entries = [e for e in entries if e.get("type") == "header"]
    message_entries = [e for e in entries if e.get("type") != "header"]

    if len(message_entries) <= target_entries:
        return entries

    # 保留最后 target_entries 条
    keep = message_entries[-target_entries:]
    dropped = message_entries[:-target_entries]

    # 生成压缩摘要
    tool_count = sum(1 for e in dropped if e.get("role") == "tool")
    assistant_count = sum(1 for e in dropped if e.get("role") == "assistant")
    event_count = sum(1 for e in dropped if e.get("type") == "event")

    first_ts = dropped[0].get("ts", "") if dropped else ""
    last_ts = dropped[-1].get("ts", "") if dropped else ""

    compaction_entry = {
        "type": "event",
        "id": _gen_id(),
        "event": "compaction",
        "detail": (
            f"Compacted {len(dropped)} entries ({assistant_count} AI, "
            f"{tool_count} tool, {event_count} event) from {first_ts} to {last_ts}"
        ),
        "compacted_count": len(dropped),
        "ts": _now_iso(),
    }

    return header_entries + [compaction_entry] + keep


# ─── Transcript 统计（参照 OpenClaw summarizeCompactionMessages）──────────────
def transcript_stats(entries: list) -> dict:
    """
    对 transcript 条目进行统计分析。
    """
    total = len(entries)
    by_type = {}
    by_role = {}
    by_tool = {}
    total_chars = 0
    truncated_count = 0
    spill_count = 0
    max_output_len = 0
    turns = set()

    for e in entries:
        # 按类型
        t = e.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1

        # 按角色
        r = e.get("role", "")
        if r:
            by_role[r] = by_role.get(r, 0) + 1

        # 按工具名
        tool = e.get("tool", "")
        if tool:
            by_tool[tool] = by_tool.get(tool, 0) + 1

        # 内容大小
        for field in ("content", "output", "input"):
            val = e.get(field, "")
            if isinstance(val, str):
                total_chars += len(val)

        # 输出大小
        output = e.get("output", "")
        if isinstance(output, str):
            max_output_len = max(max_output_len, len(output))

        # 标记
        if e.get("is_truncated"):
            truncated_count += 1
        if e.get("spill_path"):
            spill_count += 1

        # 轮次
        turn = e.get("turn")
        if turn is not None:
            turns.add(turn)

    # 时间范围
    timestamps = [e.get("ts") for e in entries if e.get("ts")]
    duration_s = None
    if len(timestamps) >= 2:
        try:
            from datetime import datetime
            t0 = datetime.fromisoformat(timestamps[0].replace('Z', '+00:00'))
            t1 = datetime.fromisoformat(timestamps[-1].replace('Z', '+00:00'))
            duration_s = round((t1 - t0).total_seconds(), 1)
        except Exception:
            pass

    return {
        "total_entries": total,
        "by_type": by_type,
        "by_role": by_role,
        "by_tool": by_tool,
        "total_chars": total_chars,
        "max_output_chars": max_output_len,
        "truncated_count": truncated_count,
        "spill_count": spill_count,
        "turns": len(turns),
        "duration_seconds": duration_s,
    }


# ─── Transcript 搜索（参照 OpenClaw searchCells / readSessionMessageByIdAsync）
def search_transcript(entries: list, query: str) -> list:
    """在 transcript 条目中搜索包含 query 的条目"""
    query_lower = query.lower()
    results = []
    for i, e in enumerate(entries):
        for field in ("content", "output", "input", "detail"):
            val = e.get(field, "")
            if isinstance(val, str) and query_lower in val.lower():
                results.append({
                    "index": i,
                    "entry_id": e.get("id", ""),
                    "field": field,
                    "snippet": _extract_snippet(val, query_lower, context=100),
                    "ts": e.get("ts", ""),
                })
                break
    return results


def _extract_snippet(text: str, query: str, context: int = 100) -> str:
    """提取搜索结果的上下文片段"""
    idx = text.lower().find(query)
    if idx == -1:
        return text[:200]
    start = max(0, idx - context)
    end = min(len(text), idx + len(query) + context)
    snippet = text[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."
    return snippet


# ─── 从本地 JSONL 文件恢复 TranscriptManager（参照 OpenClaw readSessionEntry）──
def load_transcript_from_jsonl(jsonl_path: str) -> list:
    """从 JSONL 文件加载 transcript 条目"""
    entries = []
    try:
        with open(jsonl_path, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
    except Exception as e:
        print(f"[transcript] load error: {e}", flush=True)
    return entries

