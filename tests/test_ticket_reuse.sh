#!/usr/bin/env bash
set -euo pipefail
BASE="https://skill-platform-yo5337ccva-de.a.run.app"
PASS=0; FAIL=0
green() { echo -e "\033[32m✅ $1\033[0m"; }
red()   { echo -e "\033[31m❌ $1\033[0m"; }
blue()  { echo -e "\033[34m🔷 $1\033[0m"; }
assert_contains() {
  local label="$1" body="$2" want="$3"
  if echo "$body" | grep -qE "$want"; then
    green "$label"; ((PASS++)) || true
  else
    red "$label"
    echo "   期望: $want"
    echo "   收到: $(echo "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(str(d.get("reply","(空)"))[:200])' 2>/dev/null || echo "$body" | head -c 200)"
    ((FAIL++)) || true
  fi
}

blue "获取 external skill..."
SKILLS=$(curl -sf "$BASE/api/skills" 2>/dev/null || echo '{"skills":[]}')
SKILL_ID=$(echo "$SKILLS" | python3 -c "
import sys,json
for s in json.load(sys.stdin).get('skills',[]):
    if s.get('type')=='external': print(s['id']); break
" 2>/dev/null || echo "")
[ -z "$SKILL_ID" ] && { red "无 external skill"; exit 1; }
echo "skill_id: $SKILL_ID"

TEST_USER="ttest_$(date +%s)"
echo "user_id:  $TEST_USER"

call_agent() {
  local content="$1"
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({
  'content': sys.argv[1],
  'source': 'test',
  'session_id': 'sess_' + sys.argv[2],
  'skill_id': sys.argv[3],
  'meta': {'from_name': '测试', 'user_id': sys.argv[2]},
  'context': {'available_apps': ['企业微信'], 'current_recipient': '测试'}
}))
" "$content" "$TEST_USER" "$SKILL_ID")
  curl -sf -X POST "$BASE/api/v1/agent/chat" \
    -H "Content-Type: application/json" \
    --max-time 30 \
    -d "$payload" 2>/dev/null || echo '{}'
}

set_status() {
  local tid="$1" st="$2" rsn="${3:-}"
  local b="{\"status\":\"$st\""
  [ -n "$rsn" ] && b="$b,\"return_reason\":\"$rsn\""
  curl -sf -X PUT "$BASE/api/tickets/$tid/status" \
    -H "Content-Type: application/json" -d "$b}" 2>/dev/null >/dev/null || true
}
get_route() { echo "$1" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("route_type","ERR"))' 2>/dev/null; }
get_reply() { echo "$1" | python3 -c 'import sys,json; print(str(json.load(sys.stdin).get("reply",""))[:250])' 2>/dev/null; }

echo; echo "══ T1: 首次请求 → ticket_created ══"
R1=$(call_agent "我想做AI营养分析")
RT1=$(get_route "$R1"); REPL1=$(get_reply "$R1")
echo "route: $RT1 | reply: ${REPL1:0:100}"
assert_contains "T1 ticket_created" "$R1" "ticket_created"

TICKET_ID=$(curl -sf "$BASE/api/tickets?limit=50" 2>/dev/null | python3 -c "
import sys,json
user='$TEST_USER'
ts=json.load(sys.stdin).get('tickets',[])
for t in ts:
    if t.get('created_by','')==user: print(t['id']); break
" 2>/dev/null || echo "")
echo "ticket_id: $TICKET_ID"

echo; echo "══ T2: 8s内重复 → 防抖/复用 ══"
R2=$(call_agent "再发一次链接")
RT2=$(get_route "$R2"); REPL2=$(get_reply "$R2")
echo "route: $RT2 | reply: ${REPL2:0:100}"
assert_contains "T2 防抖/复用" "$R2" "ticket_debounced|ticket_reused|处理中|等待填写|已有"

echo; echo "══ T3: 9s后 waiting_input → ticket_reused ══"
echo "  等9s..."; sleep 9
R3=$(call_agent "链接再发给我")
RT3=$(get_route "$R3"); REPL3=$(get_reply "$R3")
echo "route: $RT3 | reply: ${REPL3:0:100}"
assert_contains "T3 waiting_input→reused" "$R3" "ticket_reused|等待填写|已有"

echo; echo "══ T4: submitted → 处理中 ══"
if [ -n "$TICKET_ID" ]; then
  set_status "$TICKET_ID" "submitted"; sleep 10
  R4=$(call_agent "分析好了吗")
  RT4=$(get_route "$R4"); REPL4=$(get_reply "$R4")
  echo "route: $RT4 | reply: ${REPL4:0:150}"
  assert_contains "T4 submitted→处理中" "$R4" "处理中|稍候"
else
  red "T4跳过(无ticket_id)"; ((FAIL++)) || true
fi

echo; echo "══ T5: done → /report 链接 ══"
if [ -n "$TICKET_ID" ]; then
  set_status "$TICKET_ID" "done"; sleep 10
  R5=$(call_agent "报告好了吗")
  RT5=$(get_route "$R5"); REPL5=$(get_reply "$R5")
  echo "route: $RT5"
  echo "reply: $REPL5"
  assert_contains "T5 done→报告链接" "$R5" "/report|报告已生成"
else
  red "T5跳过"; ((FAIL++)) || true
fi

echo; echo "══ T6: returned → 打回原因+链接 ══"
if [ -n "$TICKET_ID" ]; then
  set_status "$TICKET_ID" "returned" "请补充过敏信息"; sleep 10
  R6=$(call_agent "我的工单怎么了")
  RT6=$(get_route "$R6"); REPL6=$(get_reply "$R6")
  echo "route: $RT6"
  echo "reply: $REPL6"
  assert_contains "T6 returned→打回/重新填写" "$R6" "打回|重新填写|审阅"
  assert_contains "T6 returned→含打回原因(过敏)" "$R6" "过敏"
else
  red "T6跳过"; ((FAIL++)) || true
fi

echo; echo "══ T7: error → 新建 ticket_created ══"
if [ -n "$TICKET_ID" ]; then
  set_status "$TICKET_ID" "error"; sleep 10
  R7=$(call_agent "帮我重新做营养分析")
  RT7=$(get_route "$R7"); REPL7=$(get_reply "$R7")
  echo "route: $RT7 | reply: ${REPL7:0:100}"
  assert_contains "T7 error→新建" "$R7" "ticket_created|已为您创建"
else
  red "T7跳过"; ((FAIL++)) || true
fi

echo; echo "══════════════════════════════════════"
echo "通过=$PASS  失败=$FAIL"
[ "$FAIL" -eq 0 ] && green "全部通过！" || red "有 $FAIL 个失败"
