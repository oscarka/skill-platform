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
from redact import redact_message, redact_secrets

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
        full_entry = redact_message(entry)
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

        full_entry = redact_message({
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

        display_entry = redact_message({
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
