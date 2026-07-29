#!/usr/bin/env bash
# 并发多场景测试脚本
# 用法: bash test_concurrent.sh

BACKEND="http://34.139.73.197"

# ⚠️  session_id 必须固定为每个用户的唯一标识（模拟 externalUserId）
# 不能带时间戳，否则每次都是新会话
OSCAR_SESSION="wecom_u_oscar_001"
USER2_SESSION="wecom_u_user2_001"

send() {
  local SID="$1" NAME="$2" MSG="$3"
  echo "📤 [$NAME] 发送: $MSG"
  curl -s -X POST "${BACKEND}/api/ingest" \
    -H "Content-Type: application/json" \
    -d "{
      \"content\": \"${MSG}\",
      \"source\": \"wecom\",
      \"session_id\": \"${SID}\",
      \"meta\": {\"from_name\": \"${NAME}\", \"user_id\": \"${SID}\", \"recipient\": \"${NAME}\", \"app\": \"企业微信\"},
      \"context\": {\"available_apps\": [\"企业微信\"], \"current_recipient\": \"${NAME}\"},
      \"callback_url\": \"${BACKEND}/api/agent-callback\"
    }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  →', d.get('status','?'))"
}

echo "====== 并发多场景测试 ======"
echo ""

# 场景1: 元问题/服务咨询 → 应路由 chat，直接回复
send "$OSCAR_SESSION" "oscar" "你好，我家人的健康问题也可以问嘛" &

# 场景2: 体检报告 → health → 应选 checkup-report-assistant
send "$OSCAR_SESSION" "oscar" "我刚拿到体检报告，空腹血糖6.8，总胆固醇5.9，请帮我解读一下" &

# 场景3: 营养饮食 → health → 应选 AI营养师
send "$OSCAR_SESSION" "oscar" "我最近想减肥，请帮我制定一个适合糖尿病患者的饮食方案" &

# 场景4: 普通闲聊 → chat，直接回复
send "$OSCAR_SESSION" "oscar" "你好，请问你们周末有客服吗" &

# 等所有并发请求发出
wait
echo ""
echo "====== 全部请求已发出，等待 45s 后查看日志 ======"
sleep 45

echo ""
echo "====== Cloud Run 处理日志 ======"
gcloud logging read \
  'resource.type="cloud_run_revision" resource.labels.service_name="skill-platform"' \
  --project=gen-lang-client-0884226164 \
  --limit=60 --format="value(timestamp,textPayload)" \
  --freshness=3m 2>/dev/null \
  | grep -v "^$" \
  | grep -E "request_id|routed|Skill route →|Profile:|Available|Job submitted|chat reply" \
  | tail -25
