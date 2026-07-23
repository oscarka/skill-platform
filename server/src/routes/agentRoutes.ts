/**
 * agentRoutes.ts — 通用 Agent HTTP 路由
 *
 * POST /api/v1/agent/chat                   — 主入口：接收消息，路由处理，返回 AgentResponse
 * POST /api/v1/agent/job-callback/:requestId — Cloud Run Job 完成时的内部回调
 */

import express from 'express';
import { processAgentChat, handleJobCallback } from '../agentService';

export const agentRouter = express.Router();

// ─── POST /api/v1/agent/chat ──────────────────────────────────────────────────

agentRouter.post('/chat', async (req, res) => {
  try {
    const { content, source, session_id, meta, context } = req.body;

    // Validate required fields
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
// Receives Cloud Run Job result (via TICKET_MODE CALLBACK_URL)
// Verifies sandbox secret, then forwards to the original caller's callback_url

agentRouter.post('/job-callback/:requestId', async (req, res) => {
  const EXPECTED = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
  const secret   = req.headers['x-sandbox-secret'];

  if (secret !== EXPECTED) {
    console.warn(`[AgentRoute] job-callback: invalid secret for requestId=${req.params.requestId}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { requestId } = req.params;
  console.log(`[AgentRoute] job-callback received for requestId=${requestId}`);

  // Respond immediately so the Cloud Run Job doesn't time out waiting
  res.json({ ok: true });

  // Forward result to caller asynchronously
  handleJobCallback(requestId, req.body).catch(err =>
    console.error(`[AgentRoute] job-callback forward error for ${requestId}:`, err)
  );
});
