#!/usr/bin/env python3
"""去掉 HTML 生成指令的 SKILL_MD 对比测试"""
import os, json, time, urllib.request, statistics

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
API_KEY = os.environ.get("GEMINI_API_KEY", "")  # 从环境变量读取，不硬编码
MODEL = "gemini-3.6-flash"

ALL_TOOLS = [
    {"type":"function","function":{"name":"exec","description":"在沙箱 Linux 环境里执行 bash 命令。","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer","default":60}},"required":["command"]}}},
    {"type":"function","function":{"name":"write_file","description":"写文件到沙箱文件系统","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}},
    {"type":"function","function":{"name":"read_file","description":"读取沙箱文件系统中的文件内容","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
    {"type":"function","function":{"name":"web_search","description":"搜索网络，返回 URL 和摘要。","parameters":{"type":"object","properties":{"query":{"type":"string"},"max_results":{"type":"integer","default":5}},"required":["query"]}}},
    {"type":"function","function":{"name":"invoke_skill","description":"向 Skill 发送消息。","parameters":{"type":"object","properties":{"user_message":{"type":"string"}},"required":["user_message"]}}},
]

EXEC_RULES = """

---
## 执行规则（必须遵守）
你是一个正在执行上述 Skill 的 AI Agent，拥有真实工具。
**工作流程：**
1. 先用 web_search 搜索获取真实 URL
2. 用 mcp__fetch__fetch_readable 抓取全文
3. 收集到足够信息后，直接输出最终结论
4. 不需要调用任何特殊工具来'提交'结果，直接写出结论就是完成
🚫 严格禁止：pip install / apt install / curl/wget"""

# ── 原版 SKILL_MD（包含 HTML 生成指令）─────────────────────────────────
SKILL_ORIGINAL = """# AI 营养师 — 个性化营养方案生成器

你是一位专业的AI营养顾问，根据用户提供的基本信息（年龄、性别、身高、体重、活动水平）和健康需求，制定科学、个性化的营养方案。

## 核心功能
1. **BMI 计算与评估**：根据身高体重计算BMI
2. **营养素需求计算**：基于Harris-Benedict公式计算BMR和TDEE
3. **膳食方案制定**：根据中国居民膳食指南制定三餐方案
4. **外卖优化建议**：针对经常外卖的用户提供外卖点餐建议
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

### 营养素分配
- 蛋白质: TDEE × 15-20% / 4 kcal/g
- 碳水化合物: TDEE × 50-55% / 4 kcal/g
- 脂肪: TDEE × 25-30% / 9 kcal/g

## 外卖优化策略
1. 主食选择：优先糙米饭/杂粮饭
2. 蛋白质来源：鸡胸肉/鱼/豆腐
3. 蔬菜搭配：每餐至少一份绿叶蔬菜
4. 调味控制：少油少盐
5. 饮品选择：白水/无糖茶"""

# ── 修改版 SKILL_MD（去掉所有 HTML/write_file 相关指令）──────────────────
SKILL_NO_HTML = """# AI 营养师 — 个性化营养方案生成器

你是一位专业的AI营养顾问，根据用户提供的基本信息（年龄、性别、身高、体重、活动水平）和健康需求，制定科学、个性化的营养方案。

## 核心功能
1. **BMI 计算与评估**：根据身高体重计算BMI
2. **营养素需求计算**：基于Harris-Benedict公式计算BMR和TDEE
3. **膳食方案制定**：根据中国居民膳食指南制定三餐方案
4. **外卖优化建议**：针对经常外卖的用户提供外卖点餐建议

## 输出要求
直接以文字形式输出营养方案，包含：
- 用户基本信息总结
- BMI 计算结果与评估
- 每日营养素目标（蛋白质、碳水、脂肪、纤维）
- 三餐具体方案（含热量和营养素分配）
- 改善建议清单

## 计算公式
### BMR（基础代谢率）
- 男性: 88.362 + (13.397 × 体重kg) + (4.799 × 身高cm) - (5.677 × 年龄)
- 女性: 447.593 + (9.247 × 体重kg) + (3.098 × 身高cm) - (4.330 × 年龄)

### 营养素分配
- 蛋白质: TDEE × 15-20% / 4 kcal/g
- 碳水化合物: TDEE × 50-55% / 4 kcal/g
- 脂肪: TDEE × 25-30% / 9 kcal/g

## 外卖优化策略
1. 主食选择：优先糙米饭/杂粮饭
2. 蛋白质来源：鸡胸肉/鱼/豆腐
3. 蔬菜搭配：每餐至少一份绿叶蔬菜
4. 调味控制：少油少盐
5. 饮品选择：白水/无糖茶"""

USER_MSG = "[表单提交] AI营养师 — 测试用户\n用户基本信息：42岁男性，身高178cm，体重75kg，BMI=23.67，久坐办公。\n饮食偏好：外卖为主，口味偏咸。\n健康需求：改善睡眠、控制血压、优化外卖饮食。\n请制定个性化营养方案。"

def call_once(system, user, tools, max_tokens):
    msgs = [{"role":"system","content":system},{"role":"user","content":user}]
    body = {"model":MODEL,"messages":msgs,"max_tokens":max_tokens,"stream":True}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{GEMINI_BASE}/chat/completions", data=data,
        headers={"Authorization":f"Bearer {API_KEY}","Content-Type":"application/json"},
        method="POST")
    t0 = time.time()
    r = {"ok":False,"body_bytes":len(data),"sys_chars":len(system)}
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            try: resp.fp.raw._sock.settimeout(90)
            except: pass
            first = True
            chunks = 0
            for raw in resp:
                line = raw.decode("utf-8",errors="replace").rstrip()
                if not line or not line.startswith("data:"): continue
                p = line[5:].strip()
                if p == "[DONE]": break
                try: ch = json.loads(p)
                except: continue
                chunks += 1
                if first:
                    r["ttft_ms"] = round((time.time()-t0)*1000)
                    first = False
                for c in ch.get("choices",[]):
                    if c.get("finish_reason"): r["finish"] = c["finish_reason"]
                    d = c.get("delta",{})
                    if d.get("tool_calls"):
                        r["tool_call"] = d["tool_calls"][0].get("function",{}).get("name")
            r.update({"ok":True,"total_ms":round((time.time()-t0)*1000),"chunks":chunks})
    except Exception as e:
        r.update({"error":str(e)[:200],"total_ms":round((time.time()-t0)*1000)})
    return r

def run_case(label, system, user, tools, max_tokens, repeat=3):
    print(f"\n  ▶ {label}")
    ttfts = []
    for i in range(repeat):
        r = call_once(system, user, tools, max_tokens)
        if r.get("ok"):
            ttfts.append(r["ttft_ms"])
            tc = r.get("tool_call","none")
            print(f"    run {i+1}: ✅ ttft={r['ttft_ms']}ms total={r['total_ms']}ms "
                  f"finish={r.get('finish')} tool={tc} body={r['body_bytes']}B sys={r['sys_chars']}字")
        else:
            print(f"    run {i+1}: ❌ {r.get('error','?')[:100]}")
        if i < repeat - 1:
            time.sleep(4)
    if ttfts:
        med = statistics.median(ttfts)
        print(f"    → 中位数: ttft={med}ms  (all={ttfts})")
        return med
    return None

print(f"\n🔬 SKILL_MD 内容对比：原版(含HTML) vs 去掉HTML指令")
print(f"   model={MODEL}  repeat=3\n")

# ── 测试 1: 原版 SKILL_MD（含 HTML 生成指令）──────────────────────────────
sys1 = SKILL_ORIGINAL.strip() + EXEC_RULES
t1 = run_case("原版 SKILL_MD（含 write_file + HTML 指令）", sys1, USER_MSG, ALL_TOOLS, 32000)
time.sleep(5)

# ── 测试 2: 去掉 HTML 的 SKILL_MD ──────────────────────────────────────
sys2 = SKILL_NO_HTML.strip() + EXEC_RULES
t2 = run_case("去掉 HTML/write_file 指令的 SKILL_MD", sys2, USER_MSG, ALL_TOOLS, 32000)

print(f"\n{'='*60}")
print(f"📊 对比结果")
print(f"  原版（含HTML）:  ttft中位数 = {t1}ms")
print(f"  去掉HTML:       ttft中位数 = {t2}ms")
if t1 and t2:
    print(f"  差距: {t1/t2:.1f}x")
print(f"{'='*60}")
