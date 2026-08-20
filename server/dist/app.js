"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const settingsRoutes_1 = require("./routes/settingsRoutes");
const skillRoutes_1 = require("./routes/skillRoutes");
const uploadRoutes_1 = require("./routes/uploadRoutes");
const ticketRoutes_1 = require("./routes/ticketRoutes");
const h5Routes_1 = require("./routes/h5Routes");
const resultRoutes_1 = require("./routes/resultRoutes");
const testRoutes_1 = require("./routes/testRoutes");
const mcpRoutes_1 = require("./routes/mcpRoutes");
const oauthRoutes_1 = require("./routes/oauthRoutes");
const agentRoutes_1 = require("./routes/agentRoutes");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3100', 10);
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({ origin: '*', credentials: true }));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
// ─── Static: H5 client pages ─────────────────────────────────────────────────
const H5_DIR = path_1.default.resolve(__dirname, '..', 'h5');
app.use('/h5', express_1.default.static(H5_DIR));
// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/settings', settingsRoutes_1.settingsRouter);
app.use('/api/skills', skillRoutes_1.skillRouter);
app.use('/api/upload', uploadRoutes_1.uploadRouter);
app.use('/api/tickets', ticketRoutes_1.ticketRouter);
app.use('/api/h5', h5Routes_1.h5Router);
app.use('/api/results', resultRoutes_1.resultRouter);
app.use('/api/test', testRoutes_1.testRouter);
app.use('/api/mcp-configs', mcpRoutes_1.mcpRouter);
app.use('/api/v1/agent', agentRoutes_1.agentRouter); // 通用 Agent 接口
app.use('/api/orch', agentRoutes_1.agentRouter); // 渠道统一入口（/api/orch/ingest）
app.use('/', oauthRoutes_1.oauthRouter); // OAuth routes: /auth/google/start, /auth/google/callback, /api/oauth/*
// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), version: '1.0.0' });
});
// ─── Static: Web app (React build) — must come AFTER API routes ──────────────
// In production (Cloud Run), web/dist is copied to ./public
const WEB_DIST = path_1.default.resolve(__dirname, '..', 'public');
if (require('fs').existsSync(WEB_DIST)) {
    app.use(express_1.default.static(WEB_DIST));
    // SPA fallback — all non-API routes return index.html (app.use, not app.get('*'))
    app.use((_req, res) => {
        res.sendFile(path_1.default.join(WEB_DIST, 'index.html'));
    });
    console.log('[App] Serving web app from', WEB_DIST);
}
// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[Error]', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
    await Promise.resolve((0, db_1.initDb)());
    (0, agentRoutes_1.startDispatcherLoop)(); // 启动出站消息分发后台循环（每 5s 扫 delivery_queue）
    app.listen(PORT, () => {
        console.log(`\n🚀 Skill Platform API running at http://localhost:${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/api/health`);
        console.log(`   Skills: http://localhost:${PORT}/api/skills`);
        console.log(`   Settings: http://localhost:${PORT}/api/settings\n`);
    });
}
start().catch(err => {
    console.error('[Fatal]', err);
    process.exit(1);
});
