import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db';
import { runAI } from '../aiRunner';

export const testRouter = express.Router();

// test_runs table is managed by initDb() in db-postgres.ts

// ─── POST /api/test/run ───────────────────────────────────────────────────────
// Synchronously run a skill with test inputs, return result.
testRouter.post('/run', async (req, res) => {
  try {
    const { skill_id, inputs = {}, created_by } = req.body;
    if (!skill_id) return res.status(400).json({ error: 'skill_id required' });

    const skill = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [skill_id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const defaultModelRow = await db.getAsync<any>("SELECT value FROM settings WHERE key='default_model'");
    const model = skill.preferred_model || defaultModelRow?.value || 'doubao-seed-1-8-251228';

    const start = Date.now();
    let rawResult = '';
    let errorMsg = '';

    try {
      if (skill.skill_type === 'prompt') {
        if (!skill.prompt_template) throw new Error('No prompt template');

        // Replace {{key}} placeholders
        let prompt = skill.prompt_template;
        for (const [k, v] of Object.entries(inputs as Record<string, string>)) {
          prompt = prompt.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }

        const aiRes = await runAI(prompt, {
          model,
          systemPrompt: `你是 Skill「${skill.name}」的 AI 助手，请认真完成任务。`,
        });
        rawResult = aiRes.text;

      } else if (skill.skill_type === 'code') {
        if (!skill.code) throw new Error('No skill code');
        const apiCtx = {
          callAI: async (prompt: string) => {
            const r = await runAI(prompt, { model });
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
    } catch (err: any) {
      errorMsg = err.message;
    }

    const durationMs = Date.now() - start;
    const runId = uuidv4();
    await db.runAsync(
      `INSERT INTO test_runs (id, skill_id, inputs, model, raw_result, error, duration_ms, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [runId, skill_id, JSON.stringify(inputs), model,
       rawResult || null, errorMsg || null, durationMs, created_by || null, Date.now()]
    );

    if (errorMsg) {
      return res.status(200).json({ success: false, run_id: runId, error: errorMsg, duration_ms: durationMs, model });
    }
    res.json({ success: true, run_id: runId, result: rawResult, duration_ms: durationMs, model });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/test/runs/:skillId ─────────────────────────────────────────────
testRouter.get('/runs/:skillId', async (req, res) => {
  try {
    const runs = await db.allAsync<any>(
      `SELECT id, model, duration_ms, error, created_by, created_at,
              substr(raw_result, 1, 120) as preview
       FROM test_runs WHERE skill_id=? ORDER BY created_at DESC LIMIT 20`,
      [req.params.skillId]
    );
    res.json({ runs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/test/run/:runId ─────────────────────────────────────────────────
testRouter.get('/run/:runId', async (req, res) => {
  try {
    const run = await db.getAsync<any>('SELECT * FROM test_runs WHERE id=?', [req.params.runId]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.inputs) run.inputs = JSON.parse(run.inputs);
    res.json({ run });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
