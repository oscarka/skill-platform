/**
 * agentRoutes.ts — 通用 Agent HTTP 路由
 *
 * POST /api/v1/agent/chat                   — 主入口：接收消息，路由处理，返回 AgentResponse
 * POST /api/v1/agent/job-callback/:requestId — Cloud Run Job 完成时的内部回调
 * GET  /api/v1/agent/profile                 — 读取 Agent Profile 配置
 * PUT  /api/v1/agent/profile                 — 保存 Agent Profile 配置
 * GET  /api/v1/agent/skills/available        — 读取所有已发布 skill（供前端配置页使用）
 */

import express from 'express';
import { processAgentChat, handleJobCallback, saveAgentProfile } from '../agentService';
import * as db from '../db';

export const agentRouter = express.Router();

// ─── POST /api/v1/agent/chat ──────────────────────────────────────────────────

agentRouter.post('/chat', async (req, res) => {
  try {
    const { content, source, session_id, meta, context } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'invalid_request', message: 'content is required (string)' });
    }
    if (!source) {
      return res.status(400).json({ error: 'invalid_request', message: 'source is required' });
    }
    if (!session_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'session_id is required' });
    }
    if (!meta || !meta.from_name || !meta.user_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'meta.from_name and meta.user_id are required' });
    }
    if (!context || !Array.isArray(context.available_apps)) {
      return res.status(400).json({ error: 'invalid_request', message: 'context.available_apps (array) is required' });
    }

    console.log(`[AgentRoute] POST /chat session=${session_id} source=${source} content="${content.slice(0, 60)}"`);

    const result = await processAgentChat(req.body);
    res.json(result);

  } catch (err: any) {
    console.error('[AgentRoute] /chat error:', err.message);
    res.status(500).json({
      error:   'agent_error',
      message: err.message || 'Internal agent error',
    });
  }
});

// ─── POST /api/v1/agent/job-callback/:requestId ───────────────────────────────

agentRouter.post('/job-callback/:requestId', async (req, res) => {
  const EXPECTED = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
  const secret   = req.headers['x-sandbox-secret'];

  if (secret !== EXPECTED) {
    console.warn(`[AgentRoute] job-callback: invalid secret for requestId=${req.params.requestId}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { requestId } = req.params;
  console.log(`[AgentRoute] job-callback received for requestId=${requestId}`);

  res.json({ ok: true });

  handleJobCallback(requestId, req.body).catch(err =>
    console.error(`[AgentRoute] job-callback forward error for ${requestId}:`, err)
  );
});

// ─── GET /api/v1/agent/profile ────────────────────────────────────────────────

agentRouter.get('/profile', async (_req, res) => {
  try {
    const row = await db.getAsync<any>('SELECT * FROM agent_profiles WHERE id = ?', ['default']);
    if (!row) {
      // 返回默认 profile
      return res.json({
        id:               'default',
        name:             '服务助理',
        role_desc:        '专业健康顾问助理，协助客户了解检查报告和日常健康管理',
        reply_style:      '亲切、专业，回复简洁不超过200字',
        service_flow:     '1. 判断是否为健康相关问题\n2. 健康问题优先调用对应 skill 深度分析\n3. 非健康问题礼貌回复并适当引导',
        taboos:           ['不诊断疾病', '不推荐具体药物品牌', '不承诺治疗效果'],
        reassurance_mode: 'ai',
        reassurance_tpl:  '',
        skill_mode:       'auto',
        skill_ids:        [],
      });
    }
    res.json({
      ...row,
      taboos:    JSON.parse(row.taboos || '[]'),
      skill_ids: JSON.parse(row.skill_ids || '[]'),
    });
  } catch (err: any) {
    console.error('[AgentRoute] GET /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── PUT /api/v1/agent/profile ────────────────────────────────────────────────

agentRouter.put('/profile', async (req, res) => {
  try {
    const profile = await saveAgentProfile(req.body);
    console.log(`[AgentRoute] Profile saved: skill_mode=${profile.skill_mode}`);
    res.json(profile);
  } catch (err: any) {
    console.error('[AgentRoute] PUT /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── GET /api/v1/agent/skills/available ────────────────────────────────────────

agentRouter.get('/skills/available', async (_req, res) => {
  try {
    const skills = await db.allAsync<any>(
      "SELECT id, name, description, category FROM skills WHERE status = 'published' ORDER BY name",
      []
    );
    res.json(skills);
  } catch (err: any) {
    console.error('[AgentRoute] GET /skills/available error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});
