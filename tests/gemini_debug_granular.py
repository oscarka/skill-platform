#!/usr/bin/env python3
"""
gemini_debug_granular.py — 精细梯度测试，用真实工具定义，隔离每个变量
=========================================================================
分三组测试，每组只改一个变量：

  A. Prompt 大小梯度（无工具）：100→500→1000→2000→3000→4000→4500 字
  B. 工具数量梯度（固定 4000 字 prompt）：0→1→2→3→4→5 个工具（真实定义）
  C. 工具定义大小梯度（固定 4000 字 prompt + 5 工具）：精简→真实→加大

注意：每个 case 都跑 3 次取中位数，减少随机噪声影响。

用法：
  python3 tests/gemini_debug_granular.py --key KEY [--group A|B|C|all]
"""

import argparse, json, time, urllib.request, statistics, sys

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"

# ── 真实工具定义（从 runner.py TOOLS 复制）────────────────────────────────────
TOOL_EXEC = {
    "type": "function",
    "function": {
        "name": "exec",
        "description": "在沙箱 Linux 环境里执行 bash 命令。可用于安装依赖(pip/npm)、运行脚本、处理文件。",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的 bash 命令"},
                "timeout": {"type": "integer", "description": "超时秒数，默认60", "default": 60}
            },
            "required": ["command"]
        }
    }
}
TOOL_WRITE_FILE = {
    "type": "function",
    "function": {
        "name": "write_file",
        "description": "写文件到沙箱文件系统",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"}
            },
            "required": ["path", "content"]
        }
    }
}
TOOL_READ_FILE = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "读取沙箱文件系统中的文件内容",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }
    }
}
TOOL_WEB_SEARCH = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "使用 Tavily 搜索引擎搜索网络，返回真实 URL 和内容摘要。"
            " 参照 OpenClaw web_search 工具：先用此工具搜索获得真实 URL，"
            " 再用 mcp__fetch__fetch_readable 抓取全文。"
            " 禁止直接猜测或编造文章 URL，必须先搜索。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词（英文效果更好）"},
                "max_results": {"type": "integer", "description": "最多返回几条结果（1-10，默认5）", "default": 5}
            },
            "required": ["query"]
        }
    }
}
TOOL_INVOKE_SKILL = {
    "type": "function",
    "function": {
        "name": "invoke_skill",
        "description": (
            "向当前 Skill 发送一条用户消息，返回 Skill 的回复。"
            " Skill 的 system prompt（SKILL.md 全文）已自动加载，只需传 user_message。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "user_message": {"type": "string", "description": "发给 Skill 的用户消息（即一条测试用例的内容）"}
            },
            "required": ["user_message"]
        }
    }
}
ALL_TOOLS = [TOOL_EXEC, TOOL_WRITE_FILE, TOOL_READ_FILE, TOOL_WEB_SEARCH, TOOL_INVOKE_SKILL]

# ── 真实用户消息（复用）──────────────────────────────────────────────────────
REAL_USER = """\
[表单提交] AI营养师 — 测试用户
用户基本信息：42岁男性，身高178cm，体重75kg，BMI=23.67，久坐办公。
饮食偏好：外卖为主，口味偏咸。
健康需求：改善睡眠、控制血压、优化外卖饮食。
请制定个性化营养方案并生成HTML可视化报告。"""

# ── 用于填充 prompt 的内容块（营养学知识，贴近真实 SKILL_MD 内容）────────────
_FILLER = """\
营养素参考摄入量（DRIs）是评估个体营养摄入是否适宜的标准，包括平均需要量EAR、推荐摄入量RNI、适宜摄入量AI和可耐受最高摄入量UL。\
DASH（Dietary Approaches to Stop Hypertension）饮食是一种专门为降低血压而设计的饮食模式。\
该饮食强调多摄入蔬菜、水果、全谷物、低脂乳制品，减少钠、饱和脂肪和红肉摄入。\
研究显示DASH饮食可使收缩压降低8-14mmHg，是目前最有力的非药物降压干预之一。\
地中海饮食以橄榄油、全谷物、豆类、鱼类、蔬菜水果为主，富含单不饱和脂肪酸和抗氧化物质。\
多项大型队列研究证明地中海饮食与心血管疾病、糖尿病、认知障碍的风险降低显著相关。\
中医体质分型包括平和质、气虚质、阳虚质、阴虚质、痰湿质、湿热质、血瘀质、气郁质、特禀质九种。\
不同体质有对应的食疗方案：气虚质宜补气，推荐山药、黄芪炖鸡；阴虚质宜滋阴，推荐银耳、百合、枸杞。\
运动营养学关注运动前、中、后的营养补充策略，以优化运动表现和恢复。\
运动前1-2小时建议补充低GI碳水+适量蛋白；运动后30分钟黄金窗口期补充蛋白质+碳水有助于肌肉恢复。\
"""


def make_prompt(target_chars: int) -> str:
    """生成指定字符数的 system prompt"""
    base = "你是一位专业营养顾问，根据用户信息提供科学的营养方案。\n\n"
    while len(base) < target_chars:
        base += _FILLER[:target_chars - len(base)]
    return base[:target_chars]


def call_once(api_key: str, model: str, system: str, user: str,
              tools=None, max_tokens=512) -> dict:
    """单次 LLM 调用，返回 ttft_ms / total_ms / error"""
    msgs = [{"role": "system", "content": system},
            {"role": "user",   "content": user}]
    body = {"model": model, "messages": msgs, "max_tokens": max_tokens, "stream": True}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{GEMINI_BASE}/chat/completions", data=data,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    r = {"ok": False, "ttft_ms": None, "total_ms": None, "connect_ms": None,
         "chunks": 0, "finish": None, "tool_call": None}
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            r["connect_ms"] = round((time.time() - t0) * 1000)
            try: resp.fp.raw._sock.settimeout(90)
            except: pass
            first = True
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if not line or not line.startswith("data:"): continue
                p = line[5:].strip()
                if p == "[DONE]": break
                try: ch = json.loads(p)
                except: continue
                r["chunks"] += 1
                if first:
                    r["ttft_ms"] = round((time.time() - t0) * 1000)
                    first = False
                for c in ch.get("choices", []):
                    if c.get("finish_reason"):
                        r["finish"] = c["finish_reason"]
                    d = c.get("delta", {})
                    if d.get("tool_calls"):
                        r["tool_call"] = d["tool_calls"][0].get("function", {}).get("name")
        r.update({"ok": True, "total_ms": round((time.time() - t0) * 1000)})
    except Exception as e:
        r.update({"error": str(e)[:200], "total_ms": round((time.time() - t0) * 1000)})
    return r


def run_cases(api_key: str, model: str, cases: list, repeat: int = 3, sleep_s: float = 4.0):
    """
    cases: list of {"label": str, "system": str, "user": str, "tools": list|None, "max_tokens": int}
    每个 case 跑 repeat 次，取中位数。
    """
    results = []
    for case in cases:
        label = case["label"]
        sys_prompt = case["system"]
        user = case.get("user", REAL_USER)
        tools = case.get("tools", None)
        max_tokens = case.get("max_tokens", 512)

        ttfts = []
        totals = []
        errors = []
        tool_json_bytes = len(json.dumps(tools).encode()) if tools else 0
        input_chars = len(sys_prompt) + len(user)

        print(f"\n  ▶ {label}", flush=True)
        print(f"    input={input_chars}字  tools={len(tools) if tools else 0}个({tool_json_bytes}bytes)  max_tokens={max_tokens}", flush=True)

        for i in range(repeat):
            r = call_once(api_key, model, sys_prompt, user, tools, max_tokens)
            if r.get("ok"):
                ttfts.append(r["ttft_ms"])
                totals.append(r["total_ms"])
                flag = f"ttft={r['ttft_ms']}ms  total={r['total_ms']}ms  chunks={r['chunks']}  finish={r['finish']}  tool={r['tool_call']}"
                print(f"    run {i+1}: ✅  {flag}", flush=True)
            else:
                errors.append(r.get("error", "?"))
                print(f"    run {i+1}: ❌  {r.get('error','?')[:80]}", flush=True)
            if i < repeat - 1:
                time.sleep(sleep_s)

        if ttfts:
            med_ttft = statistics.median(ttfts)
            med_total = statistics.median(totals)
            results.append({"label": label, "input_chars": input_chars,
                            "tool_count": len(tools) if tools else 0,
                            "tool_bytes": tool_json_bytes,
                            "ttft_median": med_ttft, "total_median": med_total,
                            "ttfts": ttfts, "totals": totals, "ok": True})
            print(f"    → 中位数: ttft={med_ttft}ms  total={med_total}ms  (runs={ttfts})", flush=True)
        else:
            results.append({"label": label, "ok": False, "errors": errors})
            print(f"    → 全部失败", flush=True)

        time.sleep(sleep_s)
    return results


def group_A(api_key, model, repeat):
    """A组：Prompt 大小梯度，无工具"""
    print("\n\n" + "="*70)
    print("A组：Prompt 大小梯度（固定 max_tokens=512，无工具）")
    print("="*70)
    sizes = [100, 300, 500, 1000, 1500, 2000, 3000, 4000, 4469]
    cases = [{"label": f"A{i+1}: {sz}字", "system": make_prompt(sz), "user": REAL_USER,
              "tools": None, "max_tokens": 512}
             for i, sz in enumerate(sizes)]
    return run_cases(api_key, model, cases, repeat=repeat)


def group_B(api_key, model, repeat):
    """B组：工具数量梯度，固定 4000 字 prompt"""
    print("\n\n" + "="*70)
    print("B组：工具数量梯度（固定 4000字 prompt，max_tokens=512）")
    print("="*70)
    sys_prompt = make_prompt(4000)
    tool_sequence = ALL_TOOLS
    cases = [{"label": f"B{i}: {i}个工具 ({'+'.join(t['function']['name'] for t in tool_sequence[:i]) or '无'})",
              "system": sys_prompt, "user": REAL_USER,
              "tools": tool_sequence[:i] if i > 0 else None, "max_tokens": 512}
             for i in range(len(ALL_TOOLS) + 1)]
    return run_cases(api_key, model, cases, repeat=repeat)


def group_C(api_key, model, repeat):
    """C组：max_tokens 梯度，固定 4000字 prompt + 5工具"""
    print("\n\n" + "="*70)
    print("C组：max_tokens 梯度（固定 4000字 prompt + 5工具）")
    print("="*70)
    sys_prompt = make_prompt(4000)
    tok_sizes = [256, 512, 1024, 2048, 4096, 8192, 16000, 24000, 32000]
    cases = [{"label": f"C: max_tokens={t}", "system": sys_prompt, "user": REAL_USER,
              "tools": ALL_TOOLS, "max_tokens": t}
             for t in tok_sizes]
    return run_cases(api_key, model, cases, repeat=repeat)


def print_summary(label: str, results: list):
    if not results:
        return
    print(f"\n{'='*70}")
    print(f"📊 {label} 汇总")
    print(f"{'案例':<45} {'input':>7} {'tools':>6} {'ttft中位':>10} {'total中位':>10}")
    print("-"*70)
    for r in results:
        if r.get("ok"):
            print(f"{r['label'][:45]:<45} {str(r['input_chars'])+'字':>7} "
                  f"{r['tool_count']:>6} {str(r['ttft_median'])+'ms':>10} {str(r['total_median'])+'ms':>10}")
        else:
            print(f"{r['label'][:45]:<45} ❌")
    print("="*70)


def main():
    parser = argparse.ArgumentParser(description="Gemini 精细梯度测试")
    parser.add_argument("--key",    required=True)
    parser.add_argument("--model",  default="gemini-3.6-flash")
    parser.add_argument("--group",  default="all", help="A / B / C / all")
    parser.add_argument("--repeat", type=int, default=3, help="每个 case 重复次数（取中位数）")
    args = parser.parse_args()

    print(f"\n🔬 Gemini 精细梯度测试")
    print(f"   model={args.model}  repeat={args.repeat}  endpoint={GEMINI_BASE}")

    all_results = {}
    if args.group in ("A", "all"):
        r = group_A(args.key, args.model, args.repeat)
        all_results["A"] = r
        print_summary("A组：Prompt 大小梯度", r)

    if args.group in ("B", "all"):
        r = group_B(args.key, args.model, args.repeat)
        all_results["B"] = r
        print_summary("B组：工具数量梯度", r)

    if args.group in ("C", "all"):
        r = group_C(args.key, args.model, args.repeat)
        all_results["C"] = r
        print_summary("C组：max_tokens 梯度", r)

    out = "/tmp/gemini_granular_results.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"model": args.model, "results": all_results}, f, ensure_ascii=False, indent=2)
    print(f"\n💾 原始数据: {out}")


if __name__ == "__main__":
    main()
