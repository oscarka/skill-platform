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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testRouter = void 0;
const express_1 = __importDefault(require("express"));
const uuid_1 = require("uuid");
const db = __importStar(require("../db"));
const aiRunner_1 = require("../aiRunner");
exports.testRouter = express_1.default.Router();
// test_runs table is managed by initDb() in db-postgres.ts
// ─── POST /api/test/run ───────────────────────────────────────────────────────
// Synchronously run a skill with test inputs, return result.
exports.testRouter.post('/run', async (req, res) => {
    try {
        const { skill_id, inputs = {}, created_by } = req.body;
        if (!skill_id)
            return res.status(400).json({ error: 'skill_id required' });
        const skill = await db.getAsync('SELECT * FROM skills WHERE id=?', [skill_id]);
        if (!skill)
            return res.status(404).json({ error: 'Skill not found' });
        const defaultModelRow = await db.getAsync("SELECT value FROM settings WHERE key='default_model'");
        const model = skill.preferred_model || defaultModelRow?.value || 'doubao-seed-1-8-251228';
        const start = Date.now();
        let rawResult = '';
        let errorMsg = '';
        try {
            if (skill.skill_type === 'prompt') {
                if (!skill.prompt_template)
                    throw new Error('No prompt template');
                // Replace {{key}} placeholders
                let prompt = skill.prompt_template;
                for (const [k, v] of Object.entries(inputs)) {
                    prompt = prompt.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
                }
                const aiRes = await (0, aiRunner_1.runAI)(prompt, {
                    model,
                    systemPrompt: `你是 Skill「${skill.name}」的 AI 助手，请认真完成任务。`,
                });
                rawResult = aiRes.text;
            }
            else if (skill.skill_type === 'code') {
                if (!skill.code)
                    throw new Error('No skill code');
                const apiCtx = {
                    callAI: async (prompt) => {
                        const r = await (0, aiRunner_1.runAI)(prompt, { model });
                        return r.text;
                    },
                };
                // eslint-disable-next-line no-new-func
                const fn = new Function('inputs', 'files', 'api', `
          "use strict";
          return (async () => {
            ${skill.code}
            return await invoke(inputs, files, api);
          })();
        `);
                const result = await fn(inputs, [], apiCtx);
                rawResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            }
        }
        catch (err) {
            errorMsg = err.message;
        }
        const durationMs = Date.now() - start;
        const runId = (0, uuid_1.v4)();
        await db.runAsync(`INSERT INTO test_runs (id, skill_id, inputs, model, raw_result, error, duration_ms, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, [runId, skill_id, JSON.stringify(inputs), model,
            rawResult || null, errorMsg || null, durationMs, created_by || null, Date.now()]);
        if (errorMsg) {
            return res.status(200).json({ success: false, run_id: runId, error: errorMsg, duration_ms: durationMs, model });
        }
        res.json({ success: true, run_id: runId, result: rawResult, duration_ms: durationMs, model });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/test/runs/:skillId ─────────────────────────────────────────────
exports.testRouter.get('/runs/:skillId', async (req, res) => {
    try {
        const runs = await db.allAsync(`SELECT id, model, duration_ms, error, created_by, created_at,
              substr(raw_result, 1, 120) as preview
       FROM test_runs WHERE skill_id=? ORDER BY created_at DESC LIMIT 20`, [req.params.skillId]);
        res.json({ runs });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/test/run/:runId ─────────────────────────────────────────────────
exports.testRouter.get('/run/:runId', async (req, res) => {
    try {
        const run = await db.getAsync('SELECT * FROM test_runs WHERE id=?', [req.params.runId]);
        if (!run)
            return res.status(404).json({ error: 'Run not found' });
        if (run.inputs)
            run.inputs = JSON.parse(run.inputs);
        res.json({ run });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── POST /api/test/agent-task — 测试 agent_tasks INSERT ─────────────────────
exports.testRouter.post('/agent-task', async (req, res) => {
    const testId = `test_${Date.now()}`;
    try {
        await db.runAsync(`INSERT INTO agent_tasks (id, session_id, user_id, source_channel, input_content, status, meta)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`, [testId, 'test_session', 'test_user', 'api', 'test content', JSON.stringify({ test: true })]);
        const row = await db.getAsync('SELECT * FROM agent_tasks WHERE id=?', [testId]);
        // cleanup
        await db.runAsync('DELETE FROM agent_tasks WHERE id=?', [testId]);
        res.json({ ok: true, inserted: row });
    }
    catch (err) {
        res.status(500).json({ error: err.message, testId });
    }
});
