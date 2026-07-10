#!/usr/bin/env python3
"""
验证沙箱端到端流程
用法: python3 test_sandbox.py [skill_id]
"""
import sys, time, json, urllib.request

BASE = "https://skill-platform-yo5337ccva-de.a.run.app"
SKILL_ID = sys.argv[1] if len(sys.argv) > 1 else "eb528732-ad36-4127-a482-7c8215148e25"

def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as r:
        return json.loads(r.read())

def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data,
          headers={"Content-Type":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

print(f"Testing skill: {SKILL_ID}")
print()

# 1. 触发沙箱测试
print("=== [1/3] 触发沙箱测试 ===")
r = post(f"/api/skills/{SKILL_ID}/sandbox-test")
print(f"  → {r}")
start = time.time()

# 2. 轮询进度
print("\n=== [2/3] 实时进度 ===")
last_event_count = 0
while True:
    time.sleep(10)
    prog = get(f"/api/skills/{SKILL_ID}/sandbox-progress")
    status = prog.get("status")
    events = prog.get("events", [])
    elapsed = int(time.time() - start)

    # 打印新增事件
    for e in events[last_event_count:]:
        step = e.get("step","?")
        detail = e.get("detail","")[:80]
        print(f"  [{elapsed:3d}s] [{step}] {detail}")
    last_event_count = len(events)

    if status in ("done", "failed"):
        print(f"\n  → Final status: {status}")
        break
    if elapsed > 600:
        print("  → TIMEOUT (10 min)")
        break

# 3. 查最终结果
print("\n=== [3/3] 最终结果 ===")
skill = get(f"/api/skills/{SKILL_ID}")
s = skill.get("skill") or skill
st = s.get("sandbox_test")
if st:
    result = json.loads(st) if isinstance(st, str) else st
    print(f"  passed:   {result.get('passed')}")
    print(f"  score:    {result.get('score')}")
    print(f"  output:   {str(result.get('finalOutput',''))[:300]}")
else:
    print("  No sandbox_test data")
