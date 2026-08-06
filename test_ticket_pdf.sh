#!/bin/bash
# test_ticket_pdf.sh — 用体检报告 PDF 测试工单 AI 处理
# 用法: ./test_ticket_pdf.sh [PDF_PATH]

set -e

BASE_URL="https://skill-platform-yo5337ccva-de.a.run.app"
PDF_PATH="${1:-/Users/cc/skill-platform/doc/体检报告.pdf}"
SKILL_ID="7a56f7db-b884-4fd5-818d-f59ab2907191"  # 医学报告解读助手（MD版）

echo "=== 工单 PDF 附件测试 ==="
echo "PDF: $PDF_PATH"
echo "Skill: $SKILL_ID"
echo ""

# 1. 创建工单
echo "1. 创建工单..."
TICKET=$(curl -s -X POST "$BASE_URL/api/tickets" \
  -H "Content-Type: application/json" \
  -d "{
    \"skill_id\": \"$SKILL_ID\",
    \"patient_name\": \"张三测试\",
    \"patient_phone\": \"18888888888\",
    \"created_by\": \"测试脚本\"
  }")
echo "$TICKET" | python3 -c "import json,sys; d=json.load(sys.stdin); print('Ticket ID:', d['ticket']['id']); print('Token:', d['ticket']['token'])"

TICKET_ID=$(echo "$TICKET" | python3 -c "import json,sys; print(json.load(sys.stdin)['ticket']['id'])")
TOKEN=$(echo "$TICKET" | python3 -c "import json,sys; print(json.load(sys.stdin)['ticket']['token'])")

echo ""
echo "2. 通过 H5 接口提交表单（含 PDF 附件）..."
SUBMIT=$(curl -s -X POST "$BASE_URL/api/h5/$TOKEN/submit" \
  -F "fields={\"受检人姓名\":\"张三\",\"联系电话\":\"18888888888\",\"报告出具日期\":\"2024-01-15\"}" \
  -F "files=@$PDF_PATH;type=application/pdf")
echo "Submit result: $SUBMIT"

echo ""
echo "3. 等待 AI 处理（最多 3 分钟）..."
for i in $(seq 1 18); do
  sleep 10
  STATUS=$(curl -s "$BASE_URL/api/tickets/$TICKET_ID/status")
  STATUS_VAL=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")
  echo "  [$((i*10))s] 状态: $STATUS_VAL"
  if [ "$STATUS_VAL" = "done" ] || [ "$STATUS_VAL" = "error" ]; then
    break
  fi
done

echo ""
echo "4. 获取工单结果..."
RESULT=$(curl -s "$BASE_URL/api/tickets/$TICKET_ID")
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ticket = d['ticket']
result = d.get('result')
print(f'状态: {ticket[\"status\"]}')
print(f'AI 处理时间: {ticket.get(\"ai_started_at\")} → {ticket.get(\"ai_completed_at\")}')
if result:
    print()
    print('=== AI 输出 ===')
    print(result.get('raw_result', '(空)')[:1000])
else:
    print('暂无结果')
"
echo ""
echo "=== 测试完成 ==="
echo "工单详情: $BASE_URL (管理台查看 ticket $TICKET_ID)"
