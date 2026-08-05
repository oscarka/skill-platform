#!/usr/bin/env bash
# deploy-sandbox.sh — 只重建沙箱镜像，更新 sandbox-service + sandbox Job
# 适用于：只改了 sandbox/runner.py, sandbox/server.py, Dockerfile.sandbox
# 比全量部署快 ~5 分钟（跳过主平台镜像构建）
set -euo pipefail

PROJECT="gen-lang-client-0884226164"
REGION="asia-east1"

echo "🔨 构建沙箱镜像（跳过主平台）..."
gcloud builds submit \
  --project "$PROJECT" \
  --config cloudbuild-sandbox.yaml \
  .

echo ""
echo "✅ 沙箱部署完成！"
echo "   sandbox-service: https://sandbox-service-yo5337ccva-de.a.run.app"
echo "   sandbox-job:     skill-sandbox-job (asia-east1)"
