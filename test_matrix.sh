#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# 多 Skill × 多模型 沙箱测试矩阵
# 用法:  bash test_matrix.sh [model]
# 示例:  bash test_matrix.sh doubao-seed-1-8-251228
#        bash test_matrix.sh gemini-2.0-flash
#        bash test_matrix.sh deepseek-chat
# ─────────────────────────────────────────────────────────────────────────────

MODEL="${1:-doubao-seed-1-8-251228}"
API="http://localhost:3100/api"
DB="/Users/cc/skill-platform/server/skill-platform.db"

# ─── 测试技能列表 (slug | 描述 | 预期难度) ───────────────────────────────────
# 选取4个不同类型/复杂度的真实 ClaWHub skill
SKILLS=(
  "x-hots|X热榜抓取（Prompt类·网络请求）|中"
  "cloud-iam-auditor|Cloud IAM审计（Prompt类·分析推理）|低"
  "shopify-theme-apps-detector|Shopify主题检测（Prompt+工具类）|中"
  "claw-markdown-preview|Markdown预览（Script类·HTTP服务）|高"
)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  沙箱测试矩阵   模型: $MODEL   $(date '+%H:%M:%S')"
echo "════════════════════════════════════════════════════════"

# 切换默认模型到目标模型
sqlite3 "$DB" "INSERT OR REPLACE INTO settings(key,value,updated_at) \
  VALUES('default_model','$MODEL',$(python3 -c 'import time; print(int(time.time()*1000))'))"
echo "  ✅ 默认模型已切换 → $MODEL"
echo ""

RESULTS=()

for entry in "${SKILLS[@]}"; do
  SLUG=$(echo "$entry" | cut -d'|' -f1)
  DESC=$(echo "$entry" | cut -d'|' -f2)
  DIFFICULTY=$(echo "$entry" | cut -d'|' -f3)

  echo "──────────────────────────────────────────────────────"
  echo "  ▶ $DESC  [难度:$DIFFICULTY]"

  # 1. 删除已有同 slug 的记录（保证每次测试干净）
  DELETED=$(sqlite3 "$DB" "SELECT count(*) FROM skills WHERE plugin_config LIKE '%\"slug\":\"$SLUG\"%'")
  if [ "$DELETED" -gt 0 ]; then
    sqlite3 "$DB" "DELETE FROM skills WHERE plugin_config LIKE '%\"slug\":\"$SLUG\"%'"
    echo "  🗑  清除旧记录 $DELETED 条 → 干净环境"
  fi

  # 2. 导入 skill
  echo "  📥 从 ClaWHub 导入 slug=$SLUG ..."
  IMPORT_RESP=$(curl -s -X POST "$API/skills/import-clawhub" \
    -H "Content-Type: application/json" \
    -d "{\"slug\":\"$SLUG\",\"type\":\"external\"}")
  SKILL_ID=$(echo "$IMPORT_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('skill',{}).get('id',''))
" 2>/dev/null)

  if [ -z "$SKILL_ID" ]; then
    ERR=$(echo "$IMPORT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
    echo "  ❌ 导入失败: $ERR"
    RESULTS+=("$DESC|IMPORT_FAILED|-|-|-")
    echo ""
    continue
  fi
  echo "  ✅ 导入成功: ID=$SKILL_ID"

  # 3. 触发沙箱测试
  curl -s -X POST "$API/skills/$SKILL_ID/sandbox-test" -H "Content-Type: application/json" > /dev/null
  echo "  🧪 沙箱测试已启动 (模型: $MODEL)"

  # 4. 轮询等待（最多 200s）
  WAITED=0
  STATUS="running"
  printf "     等待: "
  while [ $WAITED -lt 200 ]; do
    sleep 10
    WAITED=$((WAITED + 10))
    STATUS=$(sqlite3 "$DB" "SELECT sandbox_status FROM skills WHERE id='$SKILL_ID'")
    printf "%ds[%s] " $WAITED "$STATUS"
    if [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ]; then
      echo ""
      break
    fi
  done

  # 5. 读取并展示结果
  RAW=$(sqlite3 "$DB" "SELECT sandbox_test FROM skills WHERE id='$SKILL_ID'")
  if [ -n "$RAW" ]; then
    SCORE=$(echo "$RAW" | python3 -c "import sys,json; t=json.load(sys.stdin); print(t.get('score','?'))" 2>/dev/null)
    PASSED=$(echo "$RAW" | python3 -c "import sys,json; t=json.load(sys.stdin); print('PASS' if t.get('passed') else 'FAIL')" 2>/dev/null)
    COMMENT=$(echo "$RAW" | python3 -c "import sys,json; t=json.load(sys.stdin); print(str(t.get('comment',''))[:70])" 2>/dev/null)
    ROUNDS=$(echo "$RAW" | python3 -c "import sys,json; t=json.load(sys.stdin); tr=t.get('trace',[]); print(max([r.get('round',0) for r in tr]+[0]))" 2>/dev/null)
    MODEL_USED=$(echo "$RAW" | python3 -c "import sys,json; t=json.load(sys.stdin); print(str(t.get('model','?'))[:35])" 2>/dev/null)
    ICON="✅"
    [ "$PASSED" = "FAIL" ] && ICON="❌"
    echo "  📊 $ICON  Score: $SCORE/100  $PASSED  (${ROUNDS}轮)  model=$MODEL_USED"
    echo "     评语: $COMMENT"
    RESULTS+=("$DESC|$SCORE|$PASSED|$ROUNDS|$STATUS")
  else
    echo "  ⚠️  超时，无结果"
    RESULTS+=("$DESC|-|TIMEOUT|-|$STATUS")
  fi
  echo ""
done

# ─── 汇总表 ───────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  📊 结果汇总   模型: $MODEL"
echo "════════════════════════════════════════════════════════"
printf "  %-38s %6s  %-8s %s\n" "Skill" "分数" "轮次" "结果"
printf "  %-38s %6s  %-8s %s\n" "──────────────────────────────────────" "──────" "──────" "──────"
for r in "${RESULTS[@]}"; do
  name=$(echo "$r" | cut -d'|' -f1)
  score=$(echo "$r" | cut -d'|' -f2)
  passed=$(echo "$r" | cut -d'|' -f3)
  rounds=$(echo "$r" | cut -d'|' -f4)
  icon="✅"
  [ "$passed" = "FAIL" ] && icon="❌"
  [ "$passed" = "TIMEOUT" ] && icon="⏱️ "
  [ "$passed" = "-" ] && icon="⚠️ "
  printf "  %-38s %6s  %-8s %s %s\n" "$name" "$score" "${rounds}轮" "$icon" "$passed"
done
echo ""
echo "  完成时间: $(date '+%H:%M:%S')   模型: $MODEL"
echo "════════════════════════════════════════════════════════"
