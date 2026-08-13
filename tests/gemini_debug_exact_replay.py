#!/usr/bin/env python3
"""
gemini_debug_exact_replay.py — 用 runner.py 完全相同的请求格式测试
=================================================================
从 runner.py 代码复制：
  1. 真实的 system prompt 格式（SKILL_MD + 执行规则）
  2. 真实的 5 工具定义（exec/write_file/read_file/web_search/invoke_skill）
  3. 真实的 max_tokens=32000
  4. 真实的 user message 格式（工单表单数据）
  5. 真实的 progress hint（📍 第 1 轮 | Context ...）

对比组：
  A. 简单 prompt（上一个脚本的填充文本）— 基线
  B. 真实 system prompt（SKILL_MD + suffix）— 内容差异
  C. 真实 system prompt + progress hint — 完整复现
  D. 真实全套 + body_bytes 大小打印

每个跑 3 次取中位数。

用法：
  python3 tests/gemini_debug_exact_replay.py --key KEY
"""

import argparse, json, time, urllib.request, statistics

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"

# ── 真实工具定义（从 runner.py TOOLS 原文复制）──────────────────────────────
ALL_TOOLS = [
    {"type":"function","function":{"name":"exec","description":"在沙箱 Linux 环境里执行 bash 命令。可用于安装依赖(pip/npm)、运行脚本、处理文件。","parameters":{"type":"object","properties":{"command":{"type":"string","description":"要执行的 bash 命令"},"timeout":{"type":"integer","description":"超时秒数，默认60","default":60}},"required":["command"]}}},
    {"type":"function","function":{"name":"write_file","description":"写文件到沙箱文件系统","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}},
    {"type":"function","function":{"name":"read_file","description":"读取沙箱文件系统中的文件内容","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
    {"type":"function","function":{"name":"web_search","description":"使用 Tavily 搜索引擎搜索网络，返回真实 URL 和内容摘要。 参照 OpenClaw web_search 工具：先用此工具搜索获得真实 URL， 再用 mcp__fetch__fetch_readable 抓取全文。 禁止直接猜测或编造文章 URL，必须先搜索。","parameters":{"type":"object","properties":{"query":{"type":"string","description":"搜索关键词（英文效果更好）"},"max_results":{"type":"integer","description":"最多返回几条结果（1-10，默认5）","default":5}},"required":["query"]}}},
    {"type":"function","function":{"name":"invoke_skill","description":"向当前 Skill 发送一条用户消息，返回 Skill 的回复。 Skill 的 system prompt（SKILL.md 全文）已自动加载，只需传 user_message。","parameters":{"type":"object","properties":{"user_message":{"type":"string","description":"发给 Skill 的用户消息（即一条测试用例的内容）"}},"required":["user_message"]}}},
]

# ── 真实的执行规则 suffix（从 runner.py L1271-1286 原文复制）────────────────
EXEC_RULES_SUFFIX = """

---
## 执行规则（必须遵守）

你是一个正在执行上述 Skill 的 AI Agent，拥有真实工具。

**工作流程：**
1. **先用 web_search 搜索**获取真实 URL，禁止猜测或编造文章 URL
2. 用 mcp__fetch__fetch_readable 抓取搜索结果里的真实 URL 获取全文
3. 收集到足够信息后，直接输出最终结论（文字回复）即可完成任务
4. 不需要调用任何特殊工具来'提交'结果，直接写出结论就是完成

🚫 严格禁止：
- 禁止 pip install / apt install
- 禁止用 curl/wget 代替 MCP 工具
- MCP 工具失败时直接换 URL，不要绕路用命令行
- 信息收集够了就直接输出结论，不要无限抓取新页面"""

# ── 真实的 SKILL_MD（AI营养师 prompt_template 核心内容，约4000字）───────────
# 注意：这是近似内容。如果你有真实的 SKILL_MD，替换此处
REAL_SKILL_MD = """# AI 营养师 — 个性化营养方案生成器

你是一位专业的AI营养顾问，根据用户提供的基本信息（年龄、性别、身高、体重、活动水平）和健康需求（如减重、增肌、改善睡眠、控制血糖等），制定科学、个性化的营养方案。

## 核心功能

1. **BMI 计算与评估**：根据身高体重计算BMI，判断体重状态
2. **营养素需求计算**：基于Harris-Benedict公式计算BMR和TDEE
3. **膳食方案制定**：根据中国居民膳食指南制定三餐方案
4. **外卖优化建议**：针对经常外卖的用户提供具体的外卖点餐建议
5. **HTML 报告生成**：生成美观的可视化营养报告

## 输出要求

必须使用 `write_file` 工具生成一个完整的 HTML 文件（`nutrition_report.html`），包含：
- 用户基本信息卡片
- BMI 计算结果（带可视化仪表盘）
- 每日营养素目标（蛋白质、碳水、脂肪、纤维）
- 三餐具体方案（含热量和营养素分配）
- 改善建议清单
- 使用现代CSS设计（渐变背景、圆角卡片、响应式布局）

## 计算公式

### BMR（基础代谢率）
- 男性: 88.362 + (13.397 × 体重kg) + (4.799 × 身高cm) - (5.677 × 年龄)
- 女性: 447.593 + (9.247 × 体重kg) + (3.098 × 身高cm) - (4.330 × 年龄)

### 活动系数
- 久坐: 1.2
- 轻度活动: 1.375
- 中度活动: 1.55
- 高度活动: 1.725

### 营养素分配
- 蛋白质: TDEE × 15-20% / 4 kcal/g
- 碳水化合物: TDEE × 50-55% / 4 kcal/g  
- 脂肪: TDEE × 25-30% / 9 kcal/g

## 外卖优化策略
针对经常吃外卖的用户，提供以下指导：
1. 主食选择：优先糙米饭/杂粮饭，避免炒饭炒面
2. 蛋白质来源：鸡胸肉/鱼/豆腐，减少油炸肉类
3. 蔬菜搭配：每餐至少一份绿叶蔬菜
4. 调味控制：要求少油少盐，避免重口味菜品
5. 饮品选择：白水/无糖茶，避免含糖饮料

## 注意事项
- 方案仅供参考，不替代专业医疗建议
- 有特殊疾病（糖尿病、肾病等）的用户应咨询医生
- 过敏原提醒：标注常见过敏原（花生、海鲜、乳制品等）
"""

# ── 真实的用户消息（工单表单数据格式）──────────────────────────────────────
REAL_USER_MSG = """\
[表单提交] AI营养师 — 测试用户
用户基本信息：42岁男性，身高178cm，体重75kg，BMI=23.67，久坐办公。
饮食偏好：外卖为主，口味偏咸。
健康需求：改善睡眠、控制血压、优化外卖饮食。
请制定个性化营养方案并生成HTML可视化报告。"""

# ── 简单填充 prompt（做对照组）─────────────────────────────────────────────
SIMPLE_PROMPT = "你是一位专业营养顾问，根据用户信息提供科学的营养方案。" + ("营养素参考摄入量DRIs包括EAR、RNI、AI和UL。DASH饮食是降压饮食模式。地中海饮食富含单不饱和脂肪酸。" * 20)


def call_once(api_key, model, system, user, tools, max_tokens):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    body = {"model": model, "messages": msgs, "max_tokens": max_tokens, "stream": True}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    data = json.dumps(body).encode()
    body_bytes = len(data)

    req = urllib.request.Request(
        f"{GEMINI_BASE}/chat/completions", data=data,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    r = {"ok": False, "body_bytes": body_bytes, "system_chars": len(system), "user_chars": len(user)}
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            r["connect_ms"] = round((time.time() - t0) * 1000)
            try: resp.fp.raw._sock.settimeout(90)
            except: pass
            first = True
            chunks = 0
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if not line or not line.startswith("data:"): continue
                p = line[5:].strip()
                if p == "[DONE]": break
                try: ch = json.loads(p)
                except: continue
                chunks += 1
                if first:
                    r["ttft_ms"] = round((time.time() - t0) * 1000)
                    first = False
                for c in ch.get("choices", []):
                    if c.get("finish_reason"):
                        r["finish"] = c["finish_reason"]
                    d = c.get("delta", {})
                    if d.get("tool_calls"):
                        r["tool_call"] = d["tool_calls"][0].get("function", {}).get("name")
            r.update({"ok": True, "total_ms": round((time.time() - t0) * 1000), "chunks": chunks})
    except Exception as e:
        r.update({"error": str(e)[:200], "total_ms": round((time.time() - t0) * 1000)})
    return r


def run_case(label, api_key, model, system, user, tools, max_tokens, repeat=3, sleep_s=4.0):
    print(f"\n  ▶ {label}")
    ttfts, totals = [], []
    for i in range(repeat):
        r = call_once(api_key, model, system, user, tools, max_tokens)
        if r.get("ok"):
            ttfts.append(r["ttft_ms"])
            totals.append(r["total_ms"])
            print(f"    run {i+1}: ✅ ttft={r['ttft_ms']}ms total={r['total_ms']}ms "
                  f"chunks={r['chunks']} finish={r.get('finish')} tool={r.get('tool_call')} "
                  f"body={r['body_bytes']}B sys={r['system_chars']}字 user={r['user_chars']}字")
        else:
            print(f"    run {i+1}: ❌ {r.get('error','?')[:100]}")
        if i < repeat - 1:
            time.sleep(sleep_s)
    if ttfts:
        med = statistics.median(ttfts)
        print(f"    → 中位数: ttft={med}ms  (all={ttfts})")
        return {"label": label, "ttft_median": med, "ttfts": ttfts, "ok": True}
    return {"label": label, "ok": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--model", default="gemini-3.6-flash")
    parser.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args()

    print(f"\n🔬 精确复现 runner.py 请求格式 — 隔离 prompt 内容的影响")
    print(f"   model={args.model}  repeat={args.repeat}")

    results = []

    # ── A. 基线：简单填充 prompt + 5工具 + max_tokens=32000 ──────────────
    r = run_case("A: 简单prompt + 5工具 + max_tokens=32000",
                 args.key, args.model, SIMPLE_PROMPT[:4000], REAL_USER_MSG,
                 ALL_TOOLS, 32000, args.repeat)
    results.append(r)
    time.sleep(5)

    # ── B. 真实 SKILL_MD（无执行规则 suffix）+ 5工具 + max_tokens=32000 ──
    r = run_case("B: 真实SKILL_MD(无suffix) + 5工具 + max_tokens=32000",
                 args.key, args.model, REAL_SKILL_MD.strip(), REAL_USER_MSG,
                 ALL_TOOLS, 32000, args.repeat)
    results.append(r)
    time.sleep(5)

    # ── C. 真实 SKILL_MD + 执行规则 suffix + 5工具 + max_tokens=32000 ────
    full_system = REAL_SKILL_MD.strip() + EXEC_RULES_SUFFIX
    r = run_case("C: 真实SKILL_MD+执行规则 + 5工具 + max_tokens=32000",
                 args.key, args.model, full_system, REAL_USER_MSG,
                 ALL_TOOLS, 32000, args.repeat)
    results.append(r)
    time.sleep(5)

    # ── D. 完整复现（C + progress hint）─────────────────────────────────
    full_system_with_hint = full_system + "\n\n📍 第 1 轮 | Context 已用约 0% | 已用 0s / 剩余约 550s"
    r = run_case("D: 完整复现(C+progress_hint) + 5工具 + max_tokens=32000",
                 args.key, args.model, full_system_with_hint, REAL_USER_MSG,
                 ALL_TOOLS, 32000, args.repeat)
    results.append(r)
    time.sleep(5)

    # ── E. 无工具对照组（真实 prompt）────────────────────────────────────
    r = run_case("E: 真实SKILL_MD+执行规则 + 无工具 + max_tokens=32000",
                 args.key, args.model, full_system, REAL_USER_MSG,
                 None, 32000, args.repeat)
    results.append(r)

    # 汇总
    print(f"\n{'='*70}")
    print(f"📊 汇总")
    print(f"{'案例':<55} {'ttft中位':>10}")
    print("-"*70)
    for r in results:
        if r.get("ok"):
            print(f"{r['label'][:55]:<55} {str(r['ttft_median'])+'ms':>10}")
        else:
            print(f"{r['label'][:55]:<55} ❌")
    print("="*70)


if __name__ == "__main__":
    main()
