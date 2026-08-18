#!/usr/bin/env bash
# deploy-web.sh — 只重建主平台镜像（server + web），跳过沙箱镜像重建
# 适用于：只改了 web/ 或 server/ 代码，没改 sandbox/runner.py
set -euo pipefail

PROJECT="gen-lang-client-0884226164"
REGION="asia-east1"

echo "🔨 构建主平台镜像（跳过沙箱）..."
gcloud builds submit \
  --project "$PROJECT" \
  --region "$REGION" \
  --account oscarzhangunsw@gmail.com \
  --config cloudbuild-web.yaml \
  .

echo "✅ 部署完成！https://skill-platform-yo5337ccva-de.a.run.app"
