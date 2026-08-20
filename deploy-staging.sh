#!/bin/bash
# deploy-staging.sh — 部署候选 Agent 专用的独立 Staging Cloud Run 服务
# 
# 用途：
#   - 专供 agents_factory/ralph_loop 迭代测试使用
#   - 与主生产服务完全隔离，可随意重启/崩溃，不影响 Oscar 的真实对话
#   - 使用与主服务完全相同的镜像，仅 service name 和部分环境变量不同
#
# 使用方法：
#   ./deploy-staging.sh              # 仅部署 staging，不影响主服务
#   STAGING_TAG=xxx ./deploy-staging.sh  # 使用指定镜像 tag（默认用最新 main 构建）

set -e

PROJECT_ID="gen-lang-client-0884226164"
REGION="asia-east1"
STAGING_SERVICE="skill-platform-staging"
REPO="asia-east1-docker.pkg.dev/${PROJECT_ID}/skill-platform/platform"

# 获取最新的主服务镜像 tag（复用，无需重新构建）
LATEST_IMAGE=$(gcloud run services describe skill-platform \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(spec.template.spec.containers[0].image)" 2>/dev/null || echo "")

if [ -z "$LATEST_IMAGE" ]; then
  echo "❌ 无法获取主服务镜像，请先部署主服务：./deploy-web.sh"
  exit 1
fi

echo "🔨 Staging 服务将复用主服务镜像："
echo "   ${LATEST_IMAGE}"
echo ""
echo "🚀 部署 Staging Cloud Run 服务: ${STAGING_SERVICE}..."

# 从主服务获取现有的环境变量（只读取，不修改主服务）
MAIN_ENV=$(gcloud run services describe skill-platform \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(spec.template.spec.containers[0].env)" 2>/dev/null || echo "")

gcloud run deploy "${STAGING_SERVICE}" \
  --image="${LATEST_IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=2 \
  --timeout=300 \
  --set-env-vars="IS_STAGING=true,STAGING_AGENT_ONLY=true,PORT=3100" \
  --set-secrets="DATABASE_URL=skill-platform-db-url:latest,DOUBAO_API_KEY=doubao-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest" \
  --service-account="skill-platform-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  2>&1

STAGING_URL=$(gcloud run services describe "${STAGING_SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(status.url)")

echo ""
echo "✅ Staging 服务部署完成！"
echo "   URL: ${STAGING_URL}"
echo ""
echo "📝 将以下内容写入 agents_factory/.env.staging："
echo "PLATFORM_BASE_URL=${STAGING_URL}"
echo ""

# 自动写入 agents_factory/.env.staging（供 ralph_loop 使用）
cat > "$(dirname "$0")/agents_factory/.env.staging" << EOF
# Staging 服务配置（供 agents_factory/ralph_loop 使用）
# 此文件由 deploy-staging.sh 自动生成，请勿手动修改
PLATFORM_BASE_URL=${STAGING_URL}
IS_STAGING=true
EOF

echo "📄 已自动更新 agents_factory/.env.staging"
echo ""
echo "⚠️  重要提醒："
echo "   - Staging 服务仅用于候选 Agent 测试，请勿用真实用户 ID"
echo "   - ralph_loop 运行时请设置 PLATFORM_BASE_URL 指向 Staging"
echo "   - 转正批准后调用主服务 API 完成迁移（主服务无需重启）"
