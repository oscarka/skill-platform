#!/usr/bin/env bash
# test_route_latency.sh — 轻量路由路径端到端性能测试
# 用法: bash tests/test_route_latency.sh
# 测试内容:
#   1. 连续 5 条消息，测量端到端响应时间（含路由）
#   2. 间隔 60s 后再发 1 条，验证 CPU 热态维持（no-cpu-throttling 效果）
#   3. 拉取 Cloud Logging 中的 RouteDecision 耗时日志

set -euo pipefail

BASE_URL="https://skill-platform-339795034470.asia-east1.run.app"
PROJECT="gen-lang-client-0884226164"
TEST_USER="test-route-$(date +%s)"  # 唯一测试用户，避免污染真实数据
SESSION="$TEST_USER"

# 测试消息组合：普通闲聊 + 健康查询（触发真实路由逻辑）
declare -a MSGS=(
  "你好，你是谁"
  "我最近血糖有点高，应该注意什么"
  "我血压 135/85，正常吗"
)

echo "=========================================="
echo "轻量路由路径性能测试"
echo "服务: $BASE_URL"
echo "测试用户: $TEST_USER"
echo "=========================================="
echo ""

# ── 第一阶段：连续 5 条，每条间隔 20s（等上条处理完，避免抓占机制干扰）─────────────────────
echo "【阶段 1】连续 3 条消息（间隔 20s，无抓占）"
echo "------------------------------------------"

TOTAL=0
for i in "${!MSGS[@]}"; do
  MSG="${MSGS[$i]}"
  N=$((i + 1))

  BODY=$(cat <<EOF
{
  "from_name": "测试用户",
  "from_user_id": "$TEST_USER",
  "content": "$MSG",
  "channel": "wecom",
  "conversation_id": "$SESSION"
}
EOF
)

  RESPONSE=$(curl -s -w "\n__HTTP_CODE__:%{http_code}__TIME__:%{time_total}" \
    -X POST "$BASE_URL/api/orch/ingest" \
    -H "Content-Type: application/json" \
    -d "$BODY")

  HTTP_CODE=$(echo "$RESPONSE" | sed -n 's/.*__HTTP_CODE__:\([0-9]*\).*/\1/p')
  TIME_S=$(echo "$RESPONSE" | sed -n 's/.*__TIME__:\([0-9.]*\).*/\1/p')
  TIME_MS=$(echo "$TIME_S * 1000" | bc | xargs printf "%.0f")
  BODY_PART=$(echo "$RESPONSE" | sed 's/__HTTP_CODE__:.*//')
  REPLY=$(echo "$BODY_PART" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reply','')[:60])" 2>/dev/null || echo "(parse error)")


  TOTAL=$((TOTAL + TIME_MS))
  echo "[$N] ${TIME_MS}ms  HTTP $HTTP_CODE  msg=\"${MSG:0:20}...\""
  echo "    reply=\"$REPLY\""

  [ $i -lt $((${#MSGS[@]} - 1)) ] && sleep 20
done

AVG=$((TOTAL / ${#MSGS[@]}))
echo ""
echo "平均端到端: ${AVG}ms"
echo ""

# ── 第二阶段：等 60s 验证 CPU 热态 ──────────────────────────────────────────
echo "【阶段 2】等待 60s 后再发 1 条（验证 no-cpu-throttling 效果）"
echo "------------------------------------------"
echo "等待中..."
sleep 60

BODY2=$(cat <<EOF
{
  "from_name": "测试用户",
  "from_user_id": "$TEST_USER",
  "content": "我血糖 8.5，怎么办",
  "channel": "wecom",
  "conversation_id": "$SESSION"
}
EOF
)

RESPONSE2=$(curl -s -w "\n__HTTP_CODE__:%{http_code}__TIME__:%{time_total}" \
  -X POST "$BASE_URL/api/orch/ingest" \
  -H "Content-Type: application/json" \
  -d "$BODY2")

TIME_S2=$(echo "$RESPONSE2" | sed -n 's/.*__TIME__:\([0-9.]*\).*/\1/p')
 TIME_MS2=$(echo "$TIME_S2 * 1000" | bc | xargs printf "%.0f")
 HTTP_CODE2=$(echo "$RESPONSE2" | sed -n 's/.*__HTTP_CODE__:\([0-9]*\).*/\1/p')

echo "60s 后首条: ${TIME_MS2}ms  HTTP $HTTP_CODE2"
if [ "$TIME_MS2" -lt 3000 ]; then
  echo "✅ CPU 热态维持（< 3s，no-cpu-throttling 生效）"
else
  echo "⚠️  响应较慢（> 3s），可能 CPU 被节流"
fi

# ── 第三阶段：拉取 RouteDecision 日志 ────────────────────────────────────────
echo ""
echo "【阶段 3】RouteDecision 路由耗时日志（最近 5 分钟）"
echo "------------------------------------------"
gcloud logging read \
  "resource.labels.service_name=\"skill-platform\" AND textPayload=~\"RouteDecision\"" \
  --project="$PROJECT" \
  --limit=10 \
  --freshness=5m \
  --format="value(textPayload)" 2>/dev/null | grep -oE '\([0-9]+ms\)' | sed 's/[()ms]//g' | sort -n | \
  awk '{sum+=$1; n++; if($1>max)max=$1; if(min==""||$1<min)min=$1} END {
    if(n>0) printf "路由 AI 调用耗时：min=%dms  max=%dms  avg=%dms  共%d次\n", min, max, sum/n, n
    else print "(暂无 RouteDecision 日志，稍后再试)"
  }' 2>/dev/null || echo "(日志查询失败，可稍后手动查看)"

echo ""
echo "=========================================="
echo "测试完成"
echo "=========================================="
