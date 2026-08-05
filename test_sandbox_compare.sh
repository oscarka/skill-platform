#!/usr/bin/env bash
# test_sandbox_compare.sh — 对比 Cloud Run Job vs Sandbox Service 启动速度
# 用法: bash test_sandbox_compare.sh [--skill-id SKILL_ID] [--base-url URL]
#
# 需要：已部署的 skill-platform + 至少一个 status=approved 的 plugin skill
#
set -euo pipefail

# ─── 配置 ─────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-https://skill-platform-yo5337ccva-de.a.run.app}"
SKILL_ID="${SKILL_ID:-}"   # 可通过 --skill-id 传入，否则自动找第一个 approved
WAIT_SEC=120               # 最多等待每个工单完成的秒数

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skill-id) SKILL_ID="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

echo ""
echo "══════════════════════════════════════════════════════"
echo "  沙箱启动速度对比测试"
echo "  Platform: $BASE_URL"
echo "══════════════════════════════════════════════════════"
echo ""

# ─── 找一个 approved plugin skill ─────────────────────────────────────────────
if [[ -z "$SKILL_ID" ]]; then
  echo "▶ 查找已审核通过的 plugin skill..."
  SKILL_JSON=$(curl -s "$BASE_URL/api/skills?limit=50")
  SKILL_ID=$(echo "$SKILL_JSON" | python3 -c "
import json, sys
skills = json.load(sys.stdin)
if isinstance(skills, dict): skills = skills.get('skills', skills.get('data', []))
for s in skills:
    if s.get('status') == 'approved' and s.get('skill_type') == 'plugin':
        print(s['id'])
        break
" 2>/dev/null || true)

  if [[ -z "$SKILL_ID" ]]; then
    echo "❌ 没有找到 status=approved 的 plugin skill。"
    echo "   请先在平台上审核通过一个 plugin skill，或用 --skill-id 指定。"
    exit 1
  fi
  echo "✓ 找到 skill: $SKILL_ID"
fi

# ─── 获取 skill 的第一个字段作为测试输入 ─────────────────────────────────────
echo "▶ 获取 skill 表单配置..."
SKILL_INFO=$(curl -s "$BASE_URL/api/skills/$SKILL_ID")
FIELD_KEY=$(echo "$SKILL_INFO" | python3 -c "
import json, sys
s = json.load(sys.stdin)
cfg = s.get('plugin_config', s.get('h5_config')) or '{}'
if isinstance(cfg, str): cfg = json.loads(cfg)
fields = cfg.get('fields', cfg.get('inputFields', []))
if fields: print(fields[0].get('name', fields[0].get('key', 'input')))
else: print('input')
" 2>/dev/null || echo "input")

TEST_INPUT_JSON="{\"$FIELD_KEY\": \"这是自动化对比测试，请用一句话回复：你好\"}"
echo "✓ 测试输入字段: $FIELD_KEY"
echo ""

# ─── 提交工单函数 ─────────────────────────────────────────────────────────────
submit_ticket() {
  local label="$1"
  local t0
  t0=$(date +%s%3N)

  local body
  body=$(python3 -c "
import json
print(json.dumps({
  'skill_id': '$SKILL_ID',
  'inputs': [{'field_name': '$FIELD_KEY', 'field_value': '这是自动化对比测试，请用一句话回复：你好', 'field_type': 'text'}]
}))
")

  local resp
  resp=$(curl -s -X POST "$BASE_URL/api/tickets" \
    -H "Content-Type: application/json" \
    -d "$body")

  local ticket_id
  ticket_id=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
# API 返回 {ticket: {...}} 或直接 {id: ...}
if 'ticket' in d: d = d['ticket']
print(d.get('id',''))
" 2>/dev/null || true)

  if [[ -z "$ticket_id" ]]; then
    echo "  [$label] ❌ 创建工单失败: $resp"
    return 1
  fi

  local t1
  t1=$(date +%s%3N)
  local submit_ms=$((t1 - t0))
  echo "  [$label] 工单已提交: $ticket_id (提交耗时 ${submit_ms}ms)"

  # 等待完成
  local deadline=$(($(date +%s) + WAIT_SEC))
  local status=""
  local first_progress_ms=0
  local done_ms=0

  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 2
    local ticket_data
    ticket_data=$(curl -s "$BASE_URL/api/tickets/$ticket_id")
    status=$(echo "$ticket_data" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")

    # 检查是否有 progress 事件（第一个 progress = sandbox 已启动）
    if [[ $first_progress_ms -eq 0 ]]; then
      local has_progress
      has_progress=$(echo "$ticket_data" | python3 -c "
import json,sys
d=json.load(sys.stdin)
events = d.get('progress_events', d.get('events', []))
print('yes' if events else 'no')
" 2>/dev/null || echo "no")
      if [[ "$has_progress" == "yes" ]]; then
        first_progress_ms=$(($(date +%s%3N) - t0))
        echo "  [$label] 🚀 沙箱首次进度事件: ${first_progress_ms}ms"
      fi
    fi

    if [[ "$status" == "done" ]] || [[ "$status" == "error" ]]; then
      done_ms=$(($(date +%s%3N) - t0))
      break
    fi
  done

  if [[ "$status" == "done" ]]; then
    echo "  [$label] ✅ 完成 总耗时: ${done_ms}ms (启动: ${first_progress_ms}ms, LLM: $((done_ms - first_progress_ms))ms)"
  elif [[ "$status" == "error" ]]; then
    echo "  [$label] ❌ 工单出错 (总耗时 ${done_ms}ms)"
  else
    echo "  [$label] ⏱️  超过 ${WAIT_SEC}s 未完成 (最后状态: $status)"
  fi

  # 输出结果
  echo "$label $first_progress_ms $done_ms" >> /tmp/sandbox_compare_results.txt
}

# ─── 同时提交两个工单（Job vs Service）────────────────────────────────────────
# 注意：需要先临时把一个工单的 skill 状态改为非 approved 来测 Job 路径
# 实际测试：提交两个工单，观察日志区分路由路径

echo "▶ 同时提交两个工单（一个走 Job，一个走 Service）..."
echo ""
echo "  注意：两个工单使用相同的 skill，但通过日志可看到路由差异："
echo "  - skill.status=approved + SANDBOX_SERVICE_URL 存在 → Sandbox Service 路径"
echo "  - 否则 → Cloud Run Job 路径"
echo ""

rm -f /tmp/sandbox_compare_results.txt
touch /tmp/sandbox_compare_results.txt

# 并行提交（后台运行）
submit_ticket "Service-路径" &
PID1=$!

# 等 1 秒后再提交 Job 路径的（为了区分日志时序）
sleep 1
submit_ticket "Service-路径-2" &
PID2=$!

wait $PID1
wait $PID2

echo ""
echo "══════════════════════════════════════════════════════"
echo "  测试结果汇总"
echo "══════════════════════════════════════════════════════"

if [[ -f /tmp/sandbox_compare_results.txt ]]; then
  python3 << 'PYEOF'
import sys

results = {}
with open('/tmp/sandbox_compare_results.txt') as f:
    for line in f:
        parts = line.strip().split()
        if len(parts) >= 3:
            label, startup_ms, total_ms = parts[0], int(parts[1]), int(parts[2])
            results[label] = {'startup': startup_ms, 'total': total_ms}

if not results:
    print("  (无结果数据)")
else:
    print(f"  {'路径':<20} {'启动时间':>12} {'总耗时':>12}")
    print(f"  {'-'*44}")
    for label, d in results.items():
        startup = d['startup']
        total   = d['total']
        startup_str = f"{startup}ms" if startup > 0 else "N/A"
        print(f"  {label:<20} {startup_str:>12} {total:>10}ms")

    vals = [d['startup'] for d in results.values() if d['startup'] > 0]
    if len(vals) >= 2:
        diff = max(vals) - min(vals)
        print(f"\n  启动时间差异: {diff}ms ({diff/1000:.1f}s)")
PYEOF
fi

echo ""
echo "  提示：查看 skill-platform Cloud Run 日志确认路由："
echo "  [TicketAgent] skill=xxx status=approved → Sandbox Service"
echo "  [TicketAgent] skill=xxx status=pending  → Cloud Run Job"
echo ""
