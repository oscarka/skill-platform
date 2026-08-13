#!/usr/bin/env python3
"""
bench_gemini_connections.py
===========================
对比三种连接 Gemini API 的方式：
  方式 0（当前）: urllib.request  手写 HTTP/1.1 SSE（runner.py 当前实现）
  方式 1        : google-generativeai 官方 SDK（内部用 httpx HTTP/2 + gRPC）
  方式 2        : openai Python SDK（内部用 httpx HTTP/2，走 OpenAI 兼容层）
  方式 3 (bonus): httpx 直连 HTTP/2（手写 SSE，但 httpx 支持 HTTP/2 多路复用）

测量指标：
  - TCP 连接建立时间（connect_ms）
  - 首 token 时间（TTFT）
  - 全部 token 完成时间（total_ms）
  - token 数量（usage）
  - chunks 数量

用法：
  python3 tests/bench_gemini_connections.py --key AIza... [--model gemini-2.0-flash] [--runs 2]

依赖（都已在 sandbox/requirements.txt 里）：
  openai, httpx
  google-generativeai（如果没有会提示安装）
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
DEFAULT_MODEL   = "gemini-2.0-flash"
TEST_MESSAGES   = [
    {"role": "system", "content": "你是一个简短的助手，回答请控制在 100 字以内。"},
    {"role": "user",   "content": "请简单介绍一下 DASH 饮食法对高血压的作用。"},
]
MAX_TOKENS = 256


# ─────────────────────────────────────────────────────────────────────────────
# 方式 0：urllib（runner.py 当前实现）
# ─────────────────────────────────────────────────────────────────────────────
def bench_urllib(api_key: str, model: str) -> dict:
    body = json.dumps({
        "model": model, "messages": TEST_MESSAGES,
        "max_tokens": MAX_TOKENS, "stream": True,
    }).encode()

    req = urllib.request.Request(
        f"{GEMINI_BASE_URL}/chat/completions", data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )

    t0 = time.time()
    result = {"method": "urllib (当前)", "ok": False,
              "connect_ms": None, "ttft_ms": None, "total_ms": None, "error": None}
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            result["connect_ms"] = round((time.time() - t0) * 1000)
            try:
                r.fp.raw._sock.settimeout(60)
            except Exception:
                pass
            first = True
            content = ""
            chunks = 0
            for raw_line in r:
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                chunks += 1
                if first:
                    result["ttft_ms"] = round((time.time() - t0) * 1000)
                    first = False
                for ch in chunk.get("choices", []):
                    if ch.get("delta", {}).get("content"):
                        content += ch["delta"]["content"]
            result.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                           "chunks": chunks, "content_len": len(content),
                           "content_preview": content[:80]})
    except Exception as e:
        result["error"] = str(e)[:200]
        result["total_ms"] = round((time.time() - t0) * 1000)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 方式 1：google-generativeai 官方 SDK
# ─────────────────────────────────────────────────────────────────────────────
def bench_genai_sdk(api_key: str, model: str) -> dict:
    result = {"method": "google-generativeai SDK (方式1)", "ok": False,
              "connect_ms": None, "ttft_ms": None, "total_ms": None, "error": None}
    try:
        import google.generativeai as genai
    except ImportError:
        result["error"] = "未安装：pip install google-generativeai"
        return result

    t0 = time.time()
    try:
        genai.configure(api_key=api_key)
        g_model = genai.GenerativeModel(
            model_name=model,
            system_instruction=TEST_MESSAGES[0]["content"],
        )
        response = g_model.generate_content(
            TEST_MESSAGES[1]["content"],
            generation_config=genai.types.GenerationConfig(max_output_tokens=MAX_TOKENS),
            stream=True,
        )
        first = True
        content = ""
        chunks = 0
        for chunk in response:
            chunks += 1
            if first:
                result["connect_ms"] = round((time.time() - t0) * 1000)
                result["ttft_ms"] = round((time.time() - t0) * 1000)
                first = False
            if chunk.text:
                content += chunk.text
        result.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                       "chunks": chunks, "content_len": len(content),
                       "content_preview": content[:80]})
        try:
            u = response.usage_metadata
            result["prompt_tokens"] = u.prompt_token_count
            result["completion_tokens"] = u.candidates_token_count
        except Exception:
            pass
    except Exception as e:
        result["error"] = str(e)[:300]
        result["total_ms"] = round((time.time() - t0) * 1000)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 方式 2：openai Python SDK（走 OpenAI 兼容层，httpx HTTP/2 连接池）
# ─────────────────────────────────────────────────────────────────────────────
def bench_openai_sdk(api_key: str, model: str) -> dict:
    result = {"method": "openai SDK (方式2)", "ok": False,
              "connect_ms": None, "ttft_ms": None, "total_ms": None, "error": None}
    try:
        from openai import OpenAI
    except ImportError:
        result["error"] = "未安装：pip install openai"
        return result

    t0 = time.time()
    try:
        client = OpenAI(api_key=api_key, base_url=GEMINI_BASE_URL, timeout=180)
        stream = client.chat.completions.create(
            model=model, messages=TEST_MESSAGES,
            max_tokens=MAX_TOKENS, stream=True,
        )
        first = True
        content = ""
        chunks = 0
        p_tok = c_tok = None
        for chunk in stream:
            chunks += 1
            if first:
                result["connect_ms"] = round((time.time() - t0) * 1000)
                result["ttft_ms"] = round((time.time() - t0) * 1000)
                first = False
            if chunk.choices and chunk.choices[0].delta.content:
                content += chunk.choices[0].delta.content
            if hasattr(chunk, "usage") and chunk.usage:
                p_tok = chunk.usage.prompt_tokens
                c_tok = chunk.usage.completion_tokens
        result.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                       "chunks": chunks, "content_len": len(content),
                       "content_preview": content[:80]})
        if p_tok is not None:
            result["prompt_tokens"] = p_tok
            result["completion_tokens"] = c_tok
    except Exception as e:
        result["error"] = str(e)[:300]
        result["total_ms"] = round((time.time() - t0) * 1000)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 方式 3 (bonus)：httpx 直连，HTTP/2
# ─────────────────────────────────────────────────────────────────────────────
def bench_httpx_direct(api_key: str, model: str) -> dict:
    result = {"method": "httpx 直连 HTTP/2 (bonus方式3)", "ok": False,
              "connect_ms": None, "ttft_ms": None, "total_ms": None, "error": None}
    try:
        import httpx
    except ImportError:
        result["error"] = "未安装：pip install 'httpx[http2]'"
        return result

    body = {"model": model, "messages": TEST_MESSAGES,
            "max_tokens": MAX_TOKENS, "stream": True}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    t0 = time.time()
    try:
        with httpx.Client(http2=True, timeout=180) as client:
            with client.stream("POST", f"{GEMINI_BASE_URL}/chat/completions",
                               json=body, headers=headers) as r:
                r.raise_for_status()
                result["connect_ms"] = round((time.time() - t0) * 1000)
                first = True
                content = ""
                chunks = 0
                for line in r.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    chunks += 1
                    if first:
                        result["ttft_ms"] = round((time.time() - t0) * 1000)
                        first = False
                    for ch in chunk.get("choices", []):
                        if ch.get("delta", {}).get("content"):
                            content += ch["delta"]["content"]
        result.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                       "chunks": chunks, "content_len": len(content),
                       "content_preview": content[:80]})
    except Exception as e:
        result["error"] = str(e)[:300]
        result["total_ms"] = round((time.time() - t0) * 1000)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 主程序
# ─────────────────────────────────────────────────────────────────────────────
def run_bench(api_key: str, model: str, runs: int = 2):
    methods = [
        bench_urllib,
        bench_genai_sdk,
        bench_openai_sdk,
        bench_httpx_direct,
    ]

    print(f"\n🔬 Gemini 连接方式性能对比")
    print(f"   model={model}  runs={runs}")
    print(f"   base={GEMINI_BASE_URL}")
    print("=" * 75)

    all_results = {}
    for fn in methods:
        results = []
        # 先跑一次拿名字
        first_res = fn(api_key, model)
        name = first_res["method"]
        print(f"\n▶ {name}")
        _print_row(first_res, run_idx=1)
        results.append(first_res)
        for r in range(1, runs):
            time.sleep(3)
            res = fn(api_key, model)
            _print_row(res, run_idx=r+1)
            results.append(res)
        all_results[name] = results

    # ── 汇总表 ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 75)
    print("📊 汇总（成功次数的平均值）")
    print(f"{'方式':<40} {'connect':>10} {'TTFT':>10} {'total':>10} {'chunks':>7}")
    print("-" * 75)
    for name, results in all_results.items():
        ok = [r for r in results if r["ok"]]
        if not ok:
            print(f"{name:<40} ❌ {results[0].get('error','')[:30]}")
            continue
        def avg(k): return round(sum(r.get(k) or 0 for r in ok) / len(ok))
        label = name[:40]
        print(f"{label:<40} {str(avg('connect_ms'))+'ms':>10} "
              f"{str(avg('ttft_ms'))+'ms':>10} "
              f"{str(avg('total_ms'))+'ms':>10} "
              f"{str(round(sum(r.get('chunks',0) for r in ok)/len(ok))):>7}")
    print("=" * 75)

    out_path = "/tmp/bench_gemini_results.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    print(f"\n💾 原始数据: {out_path}")


def _print_row(res: dict, run_idx: int):
    if res["ok"]:
        print(f"  run {run_idx}: ✅  connect={res.get('connect_ms','?')}ms  "
              f"ttft={res.get('ttft_ms','?')}ms  "
              f"total={res.get('total_ms','?')}ms  "
              f"chunks={res.get('chunks',0)}  "
              f"content={res.get('content_len',0)}chars")
        if res.get("content_preview"):
            print(f"           preview: {res['content_preview'][:60]}...")
    else:
        print(f"  run {run_idx}: ❌  {res.get('error','unknown error')[:80]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 连接方式性能对比")
    parser.add_argument("--key",   required=True,
                        help="Gemini API Key (以 AIza... 或 AQ... 开头)")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"模型名，默认 {DEFAULT_MODEL}")
    parser.add_argument("--runs",  type=int, default=2,
                        help="每种方式跑几次，默认 2")
    args = parser.parse_args()
    run_bench(args.key, args.model, args.runs)
