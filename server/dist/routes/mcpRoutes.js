"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcpRouter = void 0;
const express_1 = require("express");
const db = __importStar(require("../db"));
const crypto_1 = require("crypto");
exports.mcpRouter = (0, express_1.Router)();
// GET /api/mcp-configs
exports.mcpRouter.get('/', async (_req, res) => {
    try {
        const rows = await db.allAsync('SELECT * FROM mcp_configs ORDER BY created_at DESC', []);
        res.json({ configs: rows });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/mcp-configs
exports.mcpRouter.post('/', async (req, res) => {
    const { name, command, args = '', env, description } = req.body;
    if (!name || !command)
        return res.status(400).json({ error: 'name 和 command 为必填项' });
    try {
        const id = (0, crypto_1.randomUUID)();
        await db.runAsync(`INSERT INTO mcp_configs (id, name, command, args, env, description)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args,
         env=excluded.env, description=excluded.description`, [id, name, command, args, env ? JSON.stringify(env) : null, description || null]);
        const row = await db.getAsync('SELECT * FROM mcp_configs WHERE name=?', [name]);
        res.json({ config: row });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// PUT /api/mcp-configs/:id
exports.mcpRouter.put('/:id', async (req, res) => {
    const { name, command, args, env, description } = req.body;
    try {
        await db.runAsync(`UPDATE mcp_configs SET name=?, command=?, args=?, env=?, description=? WHERE id=?`, [name, command, args ?? '', env ? JSON.stringify(env) : null, description || null, req.params.id]);
        const row = await db.getAsync('SELECT * FROM mcp_configs WHERE id=?', [req.params.id]);
        res.json({ config: row });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// DELETE /api/mcp-configs/:id
exports.mcpRouter.delete('/:id', async (req, res) => {
    try {
        await db.runAsync('DELETE FROM mcp_configs WHERE id=?', [req.params.id]);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/mcp-configs/from-progress  ← 沙箱完成后自动解析 mcporter 配置
exports.mcpRouter.post('/from-progress', async (req, res) => {
    const { events } = req.body;
    if (!Array.isArray(events))
        return res.status(400).json({ error: 'events required' });
    const saved = [];
    for (const e of events) {
        const m = (e.detail || '').match(/mcporter\s+config\s+add\s+(\S+)\s+--command\s+(\S+)(?:\s+--args\s+'([^']*)')?/);
        if (m) {
            const [, name, command, args = ''] = m;
            try {
                await db.runAsync(`INSERT INTO mcp_configs (id, name, command, args)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args`, [(0, crypto_1.randomUUID)(), name, command, args]);
                saved.push(name);
            }
            catch { /* ignore */ }
        }
    }
    res.json({ saved });
});
