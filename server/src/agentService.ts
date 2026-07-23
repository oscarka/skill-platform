/**
 * agentService.ts — Skill Platform 通用 Agent 服务
 *
 * 功能：
 * 1. Gemini 3.6 Flash 轻量路由（chat vs health）< 2s
 * 2. 普通聊天：直接 AI 回复（带历史/备注）< 10s，同步返回
 * 3. 健康咨询（有 skill_id）：提交 Cloud Run Job (TICKET_MODE)，异步 callback
 * 4. 健康咨询（无 skill_id）：直接 AI 回复（带健康档案），同步返回
 *
 * 不影响现有路由和功能，独立新增。
 */

import { v4 as uuidv4 } from 'uuid';
import * as db from './db';
import { submitSandboxJob } from './cloudRunJobsClient';

// ─── In-memory store for pending async health queries ─────────────────────────
// Key: requestId  Value: caller info needed to forward Cloud Run Job result
const pendingRequests = new Map<string, {
  callbackUrl: string;
  sessionId:   string;
  delivery:    { app: string; recipient: string; action: string };
}>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentChatRequest {
  content:          string;
  source:           string;
  session_id:       string;
  meta:             { from_name: string; user_id: string; company?: string };
  context:          { available_apps: string[]; current_recipient?: string };
  history?:         { role: 'user' | 'assistant'; content: string }[];
  notes?:           string;
  health_profile?:  string;
  skill_id?:        string;
  callback_url?:    string;
}

export interface AgentDelivery {
  app:       string;
  recipient: string;
  action:    string;
}

export interface AgentResponse {
  request_id:  string;
  status:      'done' | 'processing';
  reply:       string;
  delivery:    AgentDelivery;
  reasoning?:  string;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string> {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  return row?.value || '';
}

async function getGeminiKey(): Promise<string> {
  return (await getSetting('gemini_api_key')) || process.env.GEMINI_API_KEY || '';
}

async function getSandboxSettings() {
  const [model, doubaoKey, doubaoBase, deepseekKey, deepseekBase] = await Promise.all([
    getSetting('ai_model'),
    getSetting('doubao_api_key'),
    getSetting('doubao_base_url'),
    getSetting('deepseek_api_key'),
    getSetting('deepseek_base_url'),
  ]);
  return { model, doubaoKey, doubaoBase, deepseekKey, deepseekBase };
}

// ─── Gemini 3.6 Flash multi-turn call (OpenAI-compat endpoint) ───────────────

async function callGeminiMessages(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  apiKey: string,
  maxTokens = 4096,
): Promise<string> {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:      'gemini-3.6-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: maxTokens,
      stream:     false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const content: string = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('Gemini returned empty content');
  return content;
}

// ─── 1. Gemini 3.6 Flash 轻量路由 ────────────────────────────────────────────

async function routeMessage(content: string, notes: string, apiKey: string): Promise<'chat' | 'health'> {
  const systemPrompt = `你是一个智能分诊助手。根据客户消息判断属于哪一类：
- "chat"：普通问候、闲聊、非健康相关问题、一般性商务咨询、价格询问等
- "health"：涉及健康症状、疾病询问、饮食调理建议、用药、身体指标解读、体检报告、健身康复等

只返回 JSON，不要有其他任何内容：{"type":"chat"} 或 {"type":"health"}`;

  const userMsg = `客户备注：${notes || '（无）'}\n客户消息：${content}`;

  try {
    const result = await callGeminiMessages(systemPrompt, [{ role: 'user', content: userMsg }], apiKey, 1024);
    const match = result.match(/"type"\s*:\s*"(chat|health)"/);
    const type = match?.[1] as 'chat' | 'health' | undefined;
    console.log(`[AgentService] Route result raw="${result.trim()}" → type=${type || 'chat(fallback)'}`);
    return type || 'chat';
  } catch (err) {
    console.warn('[AgentService] Route call failed, defaulting to chat:', err);
    return 'chat';
  }
}

// ─── 2. 普通聊天：直接 AI 回复 ────────────────────────────────────────────────

async function handleChatReply(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '' } = req;
  const fromName = meta.from_name || '您';
  const { app } = delivery;

  const systemPrompt = `你是一位专业的健康顾问助理，正在通过${app}与客户${fromName}沟通。

关于该客户的备注信息：
${notes || '（无特殊备注）'}

任务：用自然、亲切的语气回复客户消息。
要求：
- 不要使用 Markdown 格式（不要**加粗**、不要#标题、不要列表符号）
- 回复简洁，通常不超过150字
- 直接称呼客户为"${fromName}"
- 如客户涉及具体健康问题，告知正在为其准备专业分析，请稍等`;

  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024);

  return {
    request_id: requestId,
    status:     'done',
    reply:      reply.trim(),
    delivery,
    reasoning:  '普通聊天，Gemini 直接回复',
  };
}

// ─── 3. 健康咨询（无 skill_id）：带档案的直接 AI 回复 ────────────────────────

async function handleHealthDirect(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '', health_profile = '' } = req;
  const fromName = meta.from_name || '您';

  const systemPrompt = `你是一位专业的健康顾问，根据客户的健康档案和问题提供专业且个性化的建议。
要求：
- 不要使用 Markdown 格式
- 回复控制在300字以内
- 亲切专业，直接称呼客户为"${fromName}"
- 如无健康档案，基于对话内容给出通用建议`;

  const contextBlock = [
    notes         ? `【客户备注】\n${notes}` : '',
    health_profile ? `【健康档案】\n${health_profile}` : '',
    `【当前问题】\n${content}`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: contextBlock },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 2048);

  return {
    request_id: requestId,
    status:     'done',
    reply:      reply.trim(),
    delivery,
    reasoning:  '健康咨询（无指定 Skill），带档案直接 AI 回复',
  };
}

// ─── 4. 健康咨询（有 skill_id）：提交 Cloud Run Job ──────────────────────────

async function handleHealthSkill(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
  serviceUrl: string,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '', health_profile = '', skill_id = '', session_id } = req;
  const fromName = meta.from_name || '您';

  // Store pending state for callback forwarding
  pendingRequests.set(requestId, {
    callbackUrl: req.callback_url || '',
    sessionId:   session_id,
    delivery,
  });

  // Build the user message for the sandbox executor
  const recentHistory = history.slice(-6)
    .map(h => `${h.role === 'user' ? '客户' : '助手'}：${h.content}`)
    .join('\n');

  const sandboxUserMessage = [
    notes          ? `【客户备注】\n${notes}` : '',
    recentHistory  ? `【近期对话记录】\n${recentHistory}` : '',
    health_profile ? `【健康档案】\n${health_profile}` : '',
    `【当前问题】\n${content}`,
    `\n请以亲切专业的口吻回复，不要使用 Markdown 格式，称呼客户为"${fromName}"。`,
  ].filter(Boolean).join('\n\n');

  // Cloud Run Job callback → our job-callback endpoint
  const jobCallbackUrl = serviceUrl
    ? `${serviceUrl}/api/v1/agent/job-callback/${requestId}`
    : '';

  try {
    await submitSandboxJob({
      skillId:       skill_id,
      userInputs:    { ticket: sandboxUserMessage },
      model:         'gemini-3.6-flash',
      aiKey:         apiKey,
      callbackUrl:   jobCallbackUrl,
      sandboxSecret: process.env.SANDBOX_SECRET || 'sandbox-secret-2024',
      caseCount:     1,
      ticketMode:    true,
    });
    console.log(`[AgentService] Cloud Run Job submitted for skill=${skill_id}, requestId=${requestId}`);
  } catch (err) {
    // If Cloud Run not available (local dev), clean up and throw
    pendingRequests.delete(requestId);
    throw err;
  }

  return {
    request_id: requestId,
    status:     'processing',
    reply:      `${fromName}您好，我正在为您分析健康情况，请稍等约 2 分钟，马上回复您～`,
    delivery,
    reasoning:  `健康咨询，已提交 Skill(${skill_id}) 异步分析，等待执行结果`,
  };
}

// ─── Cloud Run Job 完成回调处理 ───────────────────────────────────────────────

export async function handleJobCallback(requestId: string, jobResult: any): Promise<void> {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    console.warn(`[AgentService] No pending request for requestId=${requestId}`);
    return;
  }

  pendingRequests.delete(requestId);

  const { callbackUrl, sessionId, delivery } = pending;
  const agentOutput: string = (jobResult?.output || '（Agent 未返回内容）').trim();

  const callbackBody = {
    request_id: requestId,
    session_id: sessionId,
    status:     'done',
    reply:      agentOutput,
    delivery,
    reasoning:  '健康 Skill 执行完成',
  };

  console.log(`[AgentService] Job done for ${requestId}, output length=${agentOutput.length}`);

  if (!callbackUrl) {
    console.log(`[AgentService] No callback_url configured for ${requestId}`);
    return;
  }

  // Retry up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(callbackUrl, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-Agent-Secret': process.env.AGENT_SECRET || '',
        },
        body:   JSON.stringify(callbackBody),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[AgentService] Callback sent to ${callbackUrl}: HTTP ${res.status}`);
      return;
    } catch (err) {
      console.warn(`[AgentService] Callback attempt ${attempt} failed:`, err);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error(`[AgentService] All callback attempts failed for requestId=${requestId}`);
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export async function processAgentChat(req: AgentChatRequest): Promise<AgentResponse> {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error('Gemini API key not configured. Please set it in Settings.');

  const requestId  = `req_${uuidv4().replace(/-/g, '').slice(0, 10)}`;
  const serviceUrl = process.env.SERVICE_URL || '';

  // Build delivery from context (app + recipient)
  const app       = req.context.available_apps?.[0] || '企业微信';
  const recipient = req.context.current_recipient || req.meta.from_name || '';
  const delivery: AgentDelivery = { app, recipient, action: 'type_and_send' };

  console.log(`[AgentService] request_id=${requestId} session=${req.session_id} source=${req.source}`);

  // Step 1: Route
  const routeType = await routeMessage(req.content, req.notes || '', apiKey);
  console.log(`[AgentService] → routed as: ${routeType}`);

  // Step 2: Handle
  if (routeType === 'health') {
    if (req.skill_id) {
      // Async: submit Cloud Run Job
      return handleHealthSkill(req, apiKey, requestId, delivery, serviceUrl);
    } else {
      // Sync: direct AI with health profile
      return handleHealthDirect(req, apiKey, requestId, delivery);
    }
  } else {
    // Sync: chat reply
    return handleChatReply(req, apiKey, requestId, delivery);
  }
}
