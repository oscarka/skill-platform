# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20 AS builder

WORKDIR /app

# Install server deps (需要 node-gyp 编译 better-sqlite3)
COPY server/package*.json server/
RUN cd server && npm ci

# Install web deps
COPY web/package*.json web/
RUN cd web && npm ci

# Build server TypeScript → dist/
COPY server/ server/
RUN cd server && npm run build

# Build web React app → dist/
COPY web/ web/
RUN cd web && npm run build

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

# 从 builder 复制已编译的 node_modules（避免在 slim 镜像里重新编译原生模块）
COPY --from=builder /app/server/node_modules ./node_modules

# 复制编译好的 server
COPY --from=builder /app/server/dist ./dist

# 复制 web build → server 的 public 目录（静态文件服务）
COPY --from=builder /app/web/dist ./public

# Cloud Run 用 PORT 环境变量
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/app.js"]
