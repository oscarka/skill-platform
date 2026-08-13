#!/usr/bin/env python3
"""
gemini_bench_standalone.py — 完全独立的 Gemini 连接方式对比脚本
================================================================
不依赖任何项目代码，直接测试 4 种连接方式的延迟。

测试条件：
  - 使用真实大小的 prompt（~4500 字，和营养师工单 turn 1 一致）
  - 测量 connect_ms、TTFT、total_ms、token 数
  - 每种方式独立运行，互不干扰

用法：
  pip install openai httpx h2 google-genai   # 先装依赖
  python3 gemini_bench_standalone.py --key YOUR_KEY --model gemini-2.5-flash --runs 2

"""

import argparse
import json
import time
import urllib.request
import urllib.error
import socket

# ── 真实工单大小的 prompt（营养师 SKILL_MD + 表单数据，约 4500 字）─────────────
SKILL_MD = """---
name: AI营养师
description: AI全维度营养顾问。覆盖个性化饮食方案→慢病营养管理→中医体质食疗→运动营养→营养素深度解读→特殊人群营养→食物搭配优化7大模块。
location: user
allowed-tools: Read, Write, Edit, Bash, WebSearch, WebFetch
version: "1.0.0"
agent_created: true
---

# AI 全维度营养顾问

## 你的角色定位
你是一位拥有丰富临床经验的全科营养顾问。你的目标是通过科学、全面、个性化的营养分析，帮助用户实现健康目标。

## 核心工作流程

### Step 1: 深度解读用户画像
- 读取用户提交的表单数据
- 分析：基本信息（年龄/性别/身高/体重）、生活方式、健康需求、饮食偏好
- 计算 BMI、基础代谢率（BMR）、每日能量需求（TDEE）

### Step 2: 制定个性化营养方案
基于《中国居民膳食指南2022》和国际标准（DASH/地中海饮食等）：
- 宏量营养素分配：蛋白质 / 碳水化合物 / 脂肪的克数和比例
- 微量营养素重点：根据用户的健康需求和风险，列出需重点补充的维生素和矿物质
- 食物优先级排序：列出 Top 10 推荐食材，注明原因和食用方法
- 外卖/快餐选择策略：提供具体、可操作的外卖点餐原则

### Step 3: 慢病营养管理（如适用）
- 高血压：DASH饮食原则，限钠（<1500mg/天），增加钾、镁、钙
- 血糖管理：低GI食物选择，分餐策略，膳食纤维摄入
- 高血脂：减少饱和脂肪，增加 omega-3，植物固醇食物
- 睡眠优化：色氨酸食物、褪黑素前体、B族维生素

### Step 4: 中医体质食疗（可选）
根据用户提供的中医体质类型，给出对应的食疗建议。

### Step 5: 生成 HTML 可视化报告
使用 Python 脚本生成一份专业、美观的交互式 HTML 报告，包含：
- 营养成分雷达图
- 每日膳食计划表格
- 食材推荐卡片
- 外卖选择指南

## 重要原则
1. 基于循证医学，引用具体研究数据
2. 方案要可操作，避免空洞建议
3. 考虑用户的实际生活方式和限制
4. 食物多样性，避免极端饮食
5. 所有建议需适合中国饮食文化

## 营养学知识库

### 宏量营养素
- **蛋白质**：1.2-2.0g/kg体重（普通人1.2g，运动1.6-2.0g）
- **碳水**：总能量45-65%，优先全谷物、薯类、豆类
- **脂肪**：总能量20-35%，饱和脂肪<10%，反式脂肪<1%

### DASH 饮食要点
1. 每天8-10份蔬菜水果
2. 全谷物替代精制谷物
3. 低脂乳制品每天2-3份
4. 瘦肉蛋白≤170g/天
5. 坚果、豆类每周4-5次
6. 减少钠摄入（目标<1500mg/天）
7. 减少甜食和含糖饮料

### 助眠营养
- 色氨酸→血清素→褪黑素：火鸡肉、南瓜子、香蕉
- 镁：有助于肌肉放松，减少失眠：深绿色蔬菜、坚果
- B6：参与褪黑素合成：金枪鱼、鸡肉、土豆
- 避免：睡前4h内咖啡因、酒精、高糖食物

### 中国外卖健康选择原则
1. 主食：米饭<炒饭<面条，优先点白饭+菜
2. 蛋白质：蒸/煮/烤 > 炸/红烧
3. 蔬菜：每餐至少1份绿叶蔬菜
4. 汤：清汤>浓汤，少喝汤底（钠含量高）
5. 避免：锅包肉、糖醋里脊、各种炸物
"""

USER_FORM = """
[表单提交] AI营养师 — 测试用户 提交了表单

用户基本信息：
- 姓名：测试用户
- 年龄：42岁
- 性别：男
- 身高：178cm
- 体重：75kg
- BMI：23.67（正常范围）

生活方式：
- 工作性质：久坐办公室（每天坐6-8小时）
- 运动习惯：基本不运动（每周<1次）
- 做饭时间：约30分钟/天
- 饮食偏好：外卖为主（每天1-2次），口味偏咸

健康需求（按优先级）：
1. 改善睡眠质量（入睡困难，早醒）
2. 控制血压（最近测量130/85，偏高）
3. 优化外卖饮食，在繁忙工作中保持健康

过敏/禁忌：无

当前服药：无

请根据以上信息，制定个性化营养方案并生成 HTML 可视化报告。
"""

SYSTEM_PROMPT = SKILL_MD
USER_MESSAGE  = USER_FORM

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"


def _report(r: dict, run_idx: int):
    if r.get("ok"):
        print(f"  run {run_idx}: ✅  connect={r.get('connect_ms','?')}ms  "
              f"ttft={r.get('ttft_ms','?')}ms  total={r.get('total_ms','?')}ms  "
              f"chunks={r.get('chunks',0)}  content={r.get('content_len',0)}chars")
        if r.get("prompt_tokens"):
            print(f"           tokens: prompt={r['prompt_tokens']} completion={r.get('completion_tokens','?')}")
    else:
        print(f"  run {run_idx}: ❌  {r.get('error','?')[:100]}")


# ─── 方式 0: urllib (当前 runner.py 实现) ────────────────────────────────────
def bench_urllib(api_key: str, model: str) -> dict:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": USER_MESSAGE}]
    body = json.dumps({"model": model, "messages": msgs,
                       "max_tokens": 256, "stream": True}).encode()
    req = urllib.request.Request(
        f"{GEMINI_BASE}/chat/completions", data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    r = {"method": "urllib HTTP/1.1 (当前实现)", "ok": False}
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            r["connect_ms"] = round((time.time() - t0) * 1000)
            try:
                resp.fp.raw._sock.settimeout(120)
            except Exception:
                pass
            first = True
            content = ""
            chunks = 0
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if not line or not line.startswith("data:"):
                    continue
                p = line[5:].strip()
                if p == "[DONE]":
                    break
                try:
                    ch = json.loads(p)
                except Exception:
                    continue
                chunks += 1
                if first:
                    r["ttft_ms"] = round((time.time() - t0) * 1000)
                    first = False
                for c in ch.get("choices", []):
                    d = c.get("delta", {})
                    if d.get("content"):
                        content += d["content"]
                if ch.get("usage"):
                    r["prompt_tokens"] = ch["usage"].get("prompt_tokens")
                    r["completion_tokens"] = ch["usage"].get("completion_tokens")
        r.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                  "chunks": chunks, "content_len": len(content)})
    except Exception as e:
        r.update({"error": str(e)[:300], "total_ms": round((time.time()-t0)*1000)})
    return r


# ─── 方式 1: openai SDK (httpx backend) ──────────────────────────────────────
def bench_openai(api_key: str, model: str) -> dict:
    r = {"method": "openai SDK + httpx", "ok": False}
    t0 = time.time()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=GEMINI_BASE, timeout=180)
        msgs = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": USER_MESSAGE}]
        stream = client.chat.completions.create(
            model=model, messages=msgs, max_tokens=256, stream=True,
            stream_options={"include_usage": True},
        )
        first = True
        content = ""
        chunks = 0
        for chunk in stream:
            chunks += 1
            if first:
                r["connect_ms"] = r["ttft_ms"] = round((time.time()-t0)*1000)
                first = False
            if chunk.choices and chunk.choices[0].delta.content:
                content += chunk.choices[0].delta.content
            if hasattr(chunk, "usage") and chunk.usage:
                r["prompt_tokens"] = chunk.usage.prompt_tokens
                r["completion_tokens"] = chunk.usage.completion_tokens
        r.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                  "chunks": chunks, "content_len": len(content)})
    except Exception as e:
        r.update({"error": str(e)[:300], "total_ms": round((time.time()-t0)*1000)})
    return r


# ─── 方式 2: httpx 直连（HTTP/2 如果可用）────────────────────────────────────
def bench_httpx(api_key: str, model: str) -> dict:
    r = {"method": "httpx 直连", "ok": False}
    t0 = time.time()
    try:
        import httpx
        # 检测 HTTP/2 支持
        try:
            _c = httpx.Client(http2=True)
            _c.close()
            http2 = True
            r["method"] = "httpx HTTP/2 直连"
        except Exception:
            http2 = False
            r["method"] = "httpx HTTP/1.1 直连 (h2未安装)"

        msgs = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": USER_MESSAGE}]
        body = {"model": model, "messages": msgs, "max_tokens": 256, "stream": True}
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        with httpx.Client(http2=http2, timeout=180) as client:
            with client.stream("POST", f"{GEMINI_BASE}/chat/completions",
                               json=body, headers=headers) as resp:
                resp.raise_for_status()
                r["connect_ms"] = round((time.time()-t0)*1000)
                first = True
                content = ""
                chunks = 0
                for line in resp.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    p = line[5:].strip()
                    if p == "[DONE]":
                        break
                    try:
                        ch = json.loads(p)
                    except Exception:
                        continue
                    chunks += 1
                    if first:
                        r["ttft_ms"] = round((time.time()-t0)*1000)
                        first = False
                    for c in ch.get("choices", []):
                        d = c.get("delta", {})
                        if d.get("content"):
                            content += d["content"]
                    if ch.get("usage"):
                        r["prompt_tokens"] = ch["usage"].get("prompt_tokens")
                        r["completion_tokens"] = ch["usage"].get("completion_tokens")
        r.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                  "chunks": chunks, "content_len": len(content), "http2": http2})
    except Exception as e:
        r.update({"error": str(e)[:300], "total_ms": round((time.time()-t0)*1000)})
    return r


# ─── 方式 3: google-genai 官方 SDK ───────────────────────────────────────────
def bench_genai(api_key: str, model: str) -> dict:
    r = {"method": "google-genai SDK (原生API)", "ok": False}
    t0 = time.time()
    try:
        import google.genai as genai
        import google.genai.types as gtypes
        client = genai.Client(api_key=api_key)
        first = True
        content = ""
        chunks = 0
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=USER_MESSAGE,
            config=gtypes.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                max_output_tokens=256,
            ),
        ):
            chunks += 1
            if first:
                r["connect_ms"] = r["ttft_ms"] = round((time.time()-t0)*1000)
                first = False
            if chunk.text:
                content += chunk.text
        r.update({"ok": True, "total_ms": round((time.time()-t0)*1000),
                  "chunks": chunks, "content_len": len(content)})
        try:
            u = chunk.usage_metadata  # 最后一个 chunk 含 usage
            r["prompt_tokens"] = u.prompt_token_count
            r["completion_tokens"] = u.candidates_token_count
        except Exception:
            pass
    except Exception as e:
        r.update({"error": str(e)[:300], "total_ms": round((time.time()-t0)*1000)})
    return r


# ─── 主程序 ──────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Gemini 连接方式独立对比测试")
    parser.add_argument("--key",   required=True, help="Gemini API Key")
    parser.add_argument("--model", default="gemini-2.5-flash")
    parser.add_argument("--runs",  type=int, default=2, help="每种方式测几次")
    parser.add_argument("--methods", default="all",
                        help="逗号分隔: urllib,openai,httpx,genai 或 all")
    args = parser.parse_args()

    input_chars = len(SYSTEM_PROMPT) + len(USER_MESSAGE)
    input_tokens_est = round(input_chars / 2)  # 粗估（中文~2字/token）

    print(f"\n🔬 Gemini API 连接方式对比（独立脚本）")
    print(f"   model   = {args.model}")
    print(f"   runs    = {args.runs}")
    print(f"   endpoint= {GEMINI_BASE}")
    print(f"   prompt  = system {len(SYSTEM_PROMPT)}字 + user {len(USER_MESSAGE)}字 "
          f"= 共 {input_chars} 字 (~{input_tokens_est} tokens)")
    print("=" * 72)

    bench_map = {
        "urllib": bench_urllib,
        "openai": bench_openai,
        "httpx":  bench_httpx,
        "genai":  bench_genai,
    }
    if args.methods == "all":
        methods = list(bench_map.values())
    else:
        methods = [bench_map[m.strip()] for m in args.methods.split(",") if m.strip() in bench_map]

    all_results = {}
    for fn in methods:
        run_results = []
        # 先跑一次取名字
        print(f"\n▶ 测试方式: ", end="", flush=True)
        r0 = fn(args.key, args.model)
        print(r0["method"])
        _report(r0, 1)
        run_results.append(r0)
        for i in range(1, args.runs):
            time.sleep(3)
            r = fn(args.key, args.model)
            _report(r, i + 1)
            run_results.append(r)
        all_results[r0["method"]] = run_results

    # ── 汇总表 ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("📊 汇总（成功次数的平均值）")
    print(f"{'方式':<35} {'connect':>10} {'TTFT':>10} {'total':>10} {'chunks':>7}")
    print("-" * 72)
    for name, results in all_results.items():
        ok = [r for r in results if r.get("ok")]
        if not ok:
            errs = results[0].get("error", "?")[:40]
            print(f"{name[:35]:<35} ❌  {errs}")
            continue
        def avg(k): return round(sum(r.get(k) or 0 for r in ok) / len(ok))
        print(f"{name[:35]:<35} {str(avg('connect_ms'))+'ms':>10} "
              f"{str(avg('ttft_ms'))+'ms':>10} "
              f"{str(avg('total_ms'))+'ms':>10} "
              f"{str(round(sum(r.get('chunks',0) for r in ok)/len(ok))):>7}")
    print("=" * 72)

    out = "/tmp/gemini_bench_results.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"config": {"model": args.model, "input_chars": input_chars,
                               "input_tokens_est": input_tokens_est},
                   "results": all_results}, f, ensure_ascii=False, indent=2)
    print(f"\n💾 原始数据: {out}")


if __name__ == "__main__":
    main()
