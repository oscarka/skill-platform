#!/usr/bin/env python3
"""
gemini_debug_progressive.py — 逐步接入真实系统组件，定位 100s 根因
=====================================================================
策略：从最简单的请求开始，一步步添加真实组件，每次都测量 TTFT/total。
只要哪一步突然变慢，问题就在那里。

阶段（--phase）：
  0: 最小化请求（60字 prompt，无工具）               ← baseline
  1: 真实大小 prompt（~4500字），无工具              ← 验证 context size 影响
  2: 真实 prompt + 4个工具定义                      ← 验证 tools 的影响  
  3: 真实 prompt + 工具 + tool_choice=auto          ← 验证 tool_choice 影响
  4: 完整复现真实 runner.py 的第1轮请求              ← 完整真实环境

日志级别（--verbose）：
  0: 只显示汇总
  1: 显示每次调用的开始/结束
  2: 显示每个 chunk 的到达时间和间隔（完整流水账）

用法：
  python3 tests/gemini_debug_progressive.py --key KEY --phase 0  # 从0开始
  python3 tests/gemini_debug_progressive.py --key KEY --phase 1  # 然后1
  ...以此类推

  # 一次跑所有阶段（自动逐步对比）
  python3 tests/gemini_debug_progressive.py --key KEY --all
"""

import argparse
import json
import time
import urllib.request
import urllib.error
import socket
import sys

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"

# ── 真实 SKILL_MD（营养师，3843字，和生产环境一致）────────────────────────────
REAL_SKILL_MD = """\
---
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
- 读取用户提交的表单数据（JSON 格式）
- 分析：基本信息（年龄/性别/身高/体重）、生活方式、健康需求、饮食偏好
- 计算 BMI、基础代谢率（BMR）、每日能量需求（TDEE）

### Step 2: 制定个性化营养方案
基于《中国居民膳食指南2022》和国际标准（DASH/地中海饮食等）：
- 宏量营养素分配：蛋白质/碳水化合物/脂肪的克数和比例
- 微量营养素重点：根据用户的健康需求和风险列出需要重点补充的
- 食物优先级排序：列出Top10推荐食材，注明原因和食用方法
- 外卖/快餐选择策略：提供具体可操作的外卖点餐原则

### Step 3: 慢病营养管理（如适用）
- 高血压：DASH饮食原则，限钠（<1500mg/天），增加钾镁钙
- 血糖管理：低GI食物选择，分餐策略，膳食纤维摄入
- 高血脂：减少饱和脂肪，增加omega-3，植物固醇食物
- 睡眠优化：色氨酸食物、褪黑素前体、B族维生素

### Step 4: 生成 HTML 可视化报告
使用Python脚本生成一份专业美观的交互式HTML报告，包含：
- 营养成分雷达图（Chart.js）
- 每日膳食计划表格
- 食材推荐卡片
- 外卖选择指南

## 重要原则
1. 基于循证医学，引用具体研究数据（如DASH饮食可降压8-14mmHg）
2. 方案要可操作，避免空洞建议（如"多吃蔬菜"要具体到食材和量）
3. 考虑用户的实际生活方式和限制（时间、烹饪能力、预算）
4. 食物多样性，避免极端饮食
5. 所有建议需适合中国饮食文化和食材

## 营养学知识库

### 宏量营养素目标
- 蛋白质：1.2-2.0g/kg体重（普通人1.2g，运动员1.6-2.0g）
- 碳水化合物：总能量45-65%，优先全谷物、薯类、豆类
- 脂肪：总能量20-35%，饱和脂肪<10%，反式脂肪<1%

### DASH 饮食
1. 每天8-10份蔬菜水果
2. 全谷物替代精制谷物
3. 低脂乳制品每天2-3份
4. 瘦肉蛋白≤170g/天
5. 坚果、豆类每周4-5次
6. 减少钠摄入（目标<1500mg/天）
7. 减少甜食和含糖饮料

### 助眠食材
- 色氨酸→血清素→褪黑素：火鸡肉、南瓜子、香蕉、燕麦
- 镁（肌肉放松减少失眠）：深绿色蔬菜、坚果、全谷物
- 维生素B6（参与褪黑素合成）：金枪鱼、鸡肉、土豆、香蕉
- 避免：睡前4h内咖啡因、酒精、高糖高脂食物

### 中国外卖健康选择
1. 主食：白饭>炒饭>炒面（控制精制碳水）
2. 蛋白质：蒸/煮/烤>炸/红烧/糖醋
3. 蔬菜：每餐至少1份绿叶蔬菜（清炒为佳）
4. 汤：清汤>浓汤，少喝汤底（高钠）
5. 避免：锅包肉、糖醋里脊、各种炸物、腌制食品
"""

REAL_USER_INPUT = """\
[表单提交] AI营养师 — 测试用户

用户基本信息：
- 姓名：测试用户
- 年龄：42岁
- 性别：男
- 身高：178cm
- 体重：75kg
- BMI：23.67

生活方式：
- 工作：久坐办公室（6-8h/天）
- 运动：基本不运动（<1次/周）
- 做饭时间：约30分钟/天
- 饮食：外卖为主（1-2次/天），口味偏咸

健康需求（按优先级）：
1. 改善睡眠质量（入睡困难，早醒）
2. 控制血压（最近测量130/85，偏高）
3. 优化外卖饮食，在繁忙工作中保持健康

请制定个性化营养方案并生成HTML可视化报告。
"""

# ── 真实工具定义（复制自 runner.py 的 executor_tools）────────────────────────
REAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "exec",
            "description": "在沙箱中执行 shell 命令或 Python 脚本。用于数据处理、文件生成、代码执行等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的 shell 命令（支持多行，可含管道、重定向）"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "超时时间（秒），默认60，最大300",
                        "default": 60
                    }
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "将内容写入沙箱文件系统中的文件。适用于创建 HTML 报告、CSV 数据、配置文件等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径（相对于 /home/sandbox/）"
                    },
                    "content": {
                        "type": "string",
                        "description": "文件内容（字符串，支持 Unicode）"
                    }
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "使用 Tavily 搜索互联网获取最新信息。适用于查询最新营养研究、食品数据、医学指南。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索查询词"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "返回结果数量，默认5",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_report",
            "description": "生成结构化报告并保存为 HTML 文件。报告包含营养数据可视化、膳食建议等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "报告标题"},
                    "content": {"type": "string", "description": "报告 HTML 内容"},
                    "filename": {"type": "string", "description": "保存文件名（.html）"}
                },
                "required": ["title", "content"]
            }
        }
    }
]

PHASES = {
    0: {
        "name": "Phase 0: 最小 prompt，无工具",
        "system": "你是简短的助手，回答控制在60字以内。",
        "user": "简单介绍DASH饮食法对高血压的作用。",
        "tools": None,
        "tool_choice": None,
        "max_tokens": 128,
    },
    1: {
        "name": "Phase 1: 真实大小 prompt（~4000字），无工具",
        "system": REAL_SKILL_MD,
        "user": REAL_USER_INPUT,
        "tools": None,
        "tool_choice": None,
        "max_tokens": 256,
    },
    2: {
        "name": "Phase 2: 真实 prompt + 4个工具定义",
        "system": REAL_SKILL_MD,
        "user": REAL_USER_INPUT,
        "tools": REAL_TOOLS,
        "tool_choice": None,
        "max_tokens": 256,
    },
    3: {
        "name": "Phase 3: 真实 prompt + 工具 + tool_choice=auto",
        "system": REAL_SKILL_MD,
        "user": REAL_USER_INPUT,
        "tools": REAL_TOOLS,
        "tool_choice": "auto",
        "max_tokens": 256,
    },
    4: {
        "name": "Phase 4: 完整复现 runner.py turn 1（含进度提示）",
        "system": REAL_SKILL_MD + "\n\n📍 第 1 轮 | Context 已用约 0% | 已用 0s",
        "user": REAL_USER_INPUT,
        "tools": REAL_TOOLS,
        "tool_choice": "auto",
        "max_tokens": 32000,  # runner.py 的 MAX_OUTPUT_TOKENS
    },
}


def run_one_call(api_key: str, model: str, phase_cfg: dict, verbose: int = 1) -> dict:
    """执行一次 LLM 调用，记录所有关键时间点"""
    msgs = [
        {"role": "system", "content": phase_cfg["system"]},
        {"role": "user",   "content": phase_cfg["user"]},
    ]
    body_dict = {
        "model":      model,
        "messages":   msgs,
        "max_tokens": phase_cfg["max_tokens"],
        "stream":     True,
    }
    if phase_cfg.get("tools"):
        body_dict["tools"] = phase_cfg["tools"]
    if phase_cfg.get("tool_choice"):
        body_dict["tool_choice"] = phase_cfg["tool_choice"]

    body = json.dumps(body_dict).encode()
    input_chars = sum(len(m["content"]) for m in msgs)
    tool_count = len(phase_cfg.get("tools") or [])

    req = urllib.request.Request(
        f"{GEMINI_BASE}/chat/completions", data=body,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )

    t0 = time.time()
    r = {
        "ok": False,
        "input_chars": input_chars,
        "tool_count": tool_count,
        "connect_ms": None,
        "ttft_ms": None,
        "total_ms": None,
        "chunks": 0,
        "content_len": 0,
        "prompt_tokens": None,
        "completion_tokens": None,
        "finish_reason": None,
        "gap_max_ms": 0,   # 最大 chunk 间隔（>1s 说明中途卡住）
        "gaps_over_1s": 0, # 超过1秒间隔的次数
        "error": None,
    }

    if verbose >= 1:
        print(f"   [{_ts()}] → POST {GEMINI_BASE}/chat/completions", flush=True)
        print(f"            model={model} input={input_chars}chars tools={tool_count} max_tokens={phase_cfg['max_tokens']}", flush=True)

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            t_connect = time.time()
            r["connect_ms"] = round((t_connect - t0) * 1000)
            if verbose >= 1:
                print(f"   [{_ts()}] ✓ connected  status={resp.status}  connect={r['connect_ms']}ms", flush=True)

            try:
                resp.fp.raw._sock.settimeout(120)
            except Exception:
                pass

            first = True
            content = ""
            content_parts = []
            tool_calls_detected = []
            last_chunk_t = t_connect
            chunk_times = []

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

                now = time.time()
                gap_ms = round((now - last_chunk_t) * 1000)
                last_chunk_t = now
                r["chunks"] += 1

                if first:
                    r["ttft_ms"] = round((now - t0) * 1000)
                    first = False
                    if verbose >= 1:
                        print(f"   [{_ts()}] ⚡ first_token  ttft={r['ttft_ms']}ms", flush=True)

                # 记录大间隔
                if r["chunks"] > 1:
                    if gap_ms > r["gap_max_ms"]:
                        r["gap_max_ms"] = gap_ms
                    if gap_ms > 1000:
                        r["gaps_over_1s"] += 1
                        if verbose >= 1:
                            print(f"   [{_ts()}] ⚠️  chunk gap={gap_ms}ms (chunk #{r['chunks']})", flush=True)

                if verbose >= 2:
                    chunk_times.append(gap_ms)
                    print(f"   [{_ts()}] chunk #{r['chunks']:3d}  gap={gap_ms:6d}ms", flush=True)

                # 解析内容
                for c in ch.get("choices", []):
                    d = c.get("delta", {})
                    if d.get("content"):
                        content += d["content"]
                    if d.get("tool_calls"):
                        for tc in d["tool_calls"]:
                            fn = tc.get("function", {})
                            if fn.get("name") and fn["name"] not in tool_calls_detected:
                                tool_calls_detected.append(fn["name"])
                    if c.get("finish_reason"):
                        r["finish_reason"] = c["finish_reason"]

                # usage
                if ch.get("usage"):
                    r["prompt_tokens"] = ch["usage"].get("prompt_tokens")
                    r["completion_tokens"] = ch["usage"].get("completion_tokens")

            r.update({
                "ok": True,
                "total_ms": round((time.time() - t0) * 1000),
                "content_len": len(content),
                "tool_calls": tool_calls_detected,
                "content_preview": content[:80],
            })
            if verbose >= 1:
                print(f"   [{_ts()}] ✓ done  total={r['total_ms']}ms  chunks={r['chunks']}  "
                      f"content={r['content_len']}chars  tool_calls={tool_calls_detected or 'none'}  "
                      f"finish={r['finish_reason']}  gap_max={r['gap_max_ms']}ms  "
                      f"gaps>1s={r['gaps_over_1s']}  "
                      f"tokens=prompt:{r.get('prompt_tokens','?')}/comp:{r.get('completion_tokens','?')}", flush=True)

    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        err_body = body_bytes.decode(errors="replace")[:400]
        r.update({"error": f"HTTP {e.code}: {err_body}", "total_ms": round((time.time()-t0)*1000)})
        if verbose >= 1:
            print(f"   [{_ts()}] ❌ HTTP {e.code}: {err_body[:200]}", flush=True)
    except Exception as e:
        r.update({"error": str(e)[:300], "total_ms": round((time.time()-t0)*1000)})
        if verbose >= 1:
            print(f"   [{_ts()}] ❌ {str(e)[:200]}", flush=True)

    return r


def _ts():
    """返回当前时间戳 HH:MM:SS.mmm"""
    t = time.time()
    ms = int((t % 1) * 1000)
    import datetime
    s = datetime.datetime.fromtimestamp(t).strftime("%H:%M:%S")
    return f"{s}.{ms:03d}"


def run_phase(api_key: str, model: str, phase: int, runs: int, verbose: int):
    cfg = PHASES[phase]
    input_chars = len(cfg["system"]) + len(cfg["user"])
    tool_count = len(cfg.get("tools") or [])

    print(f"\n{'='*70}")
    print(f"🔬 {cfg['name']}")
    print(f"   input: system={len(cfg['system'])}字 + user={len(cfg['user'])}字 = {input_chars}字")
    print(f"   tools: {tool_count}个  tool_choice: {cfg.get('tool_choice') or '未设置'}")
    print(f"   max_tokens: {cfg['max_tokens']}")
    print(f"{'='*70}")

    results = []
    for i in range(runs):
        if i > 0:
            print(f"\n  --- run {i+1}/{runs}（等3s） ---")
            time.sleep(3)
        else:
            print(f"\n  --- run {i+1}/{runs} ---")
        r = run_one_call(api_key, model, cfg, verbose=verbose)
        results.append(r)

    ok = [r for r in results if r.get("ok")]
    if ok:
        def avg(k): return round(sum(r.get(k) or 0 for r in ok) / len(ok))
        print(f"\n  📊 {cfg['name']} 平均 ({len(ok)}/{runs} 成功):")
        print(f"     connect={avg('connect_ms')}ms  TTFT={avg('ttft_ms')}ms  total={avg('total_ms')}ms  chunks={avg('chunks')}")
        print(f"     gap_max={avg('gap_max_ms')}ms  gaps>1s={avg('gaps_over_1s')}  content={avg('content_len')}chars")
    else:
        print(f"\n  ❌ 全部失败: {results[0].get('error','?')[:100]}")

    return {"phase": phase, "name": cfg["name"], "results": results}


def main():
    parser = argparse.ArgumentParser(description="Gemini 逐步接入调试工具")
    parser.add_argument("--key",     required=True, help="Gemini API Key")
    parser.add_argument("--model",   default="gemini-3.6-flash")
    parser.add_argument("--phase",   type=int, default=None,
                        help="运行指定阶段 0-4（不指定则用 --all）")
    parser.add_argument("--all",     action="store_true",
                        help="逐步运行所有阶段 0→4")
    parser.add_argument("--runs",    type=int, default=1)
    parser.add_argument("--verbose", type=int, default=1,
                        help="0=仅汇总 1=主要时间点 2=每个chunk")
    args = parser.parse_args()

    if args.phase is None and not args.all:
        print("请指定 --phase 0-4 或 --all")
        parser.print_help()
        sys.exit(1)

    phases_to_run = list(range(5)) if args.all else [args.phase]

    print(f"\n🚀 Gemini 逐步调试 — model={args.model}  runs={args.runs}  verbose={args.verbose}")
    print(f"   endpoint: {GEMINI_BASE}")

    all_results = []
    summary_rows = []

    for p in phases_to_run:
        res = run_phase(args.key, args.model, p, args.runs, args.verbose)
        all_results.append(res)
        ok = [r for r in res["results"] if r.get("ok")]
        if ok:
            def avg(k): return round(sum(r.get(k) or 0 for r in ok) / len(ok))
            summary_rows.append((res["name"], avg("connect_ms"), avg("ttft_ms"), avg("total_ms"),
                                 avg("chunks"), avg("gap_max_ms"), avg("gaps_over_1s"),
                                 ok[0].get("prompt_tokens","?")))
        else:
            summary_rows.append((res["name"], None, None, None, None, None, None, None))
        if args.all and p < max(phases_to_run):
            print(f"\n⏱️  等 5s 再跑下一阶段...", flush=True)
            time.sleep(5)

    # ── 最终汇总对比表 ─────────────────────────────────────────────────────
    if len(phases_to_run) > 1:
        print(f"\n\n{'='*80}")
        print("📊 全阶段对比汇总")
        print(f"{'阶段':<42} {'TTFT':>8} {'total':>8} {'chunks':>7} {'gap_max':>9} {'prompt_tok':>11}")
        print("-"*80)
        for row in summary_rows:
            name, conn, ttft, total, chunks, gap, gaps1s, ptok = row
            if ttft is None:
                print(f"{name[:42]:<42} ❌ 全部失败")
            else:
                print(f"{name[:42]:<42} {str(ttft)+'ms':>8} {str(total)+'ms':>8} "
                      f"{str(chunks):>7} {str(gap)+'ms':>9} {str(ptok):>11}")
        print("="*80)

    # 保存原始数据
    out = "/tmp/gemini_debug_results.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"model": args.model, "phases": all_results},
                  f, ensure_ascii=False, indent=2)
    print(f"\n💾 原始数据: {out}")


if __name__ == "__main__":
    main()
