/**
 * agentService.ts — Skill Platform 通用 Agent 服务 v2
 *
 * 新增：
 * 1. Agent Profile：从 DB 读取服务配置（角色、流程、禁忌、可用 skill）
 * 2. 自动 Skill 路由：Gemini 从可用 skill 中选最合适的一个
 * 3. 安抚消息：支持 AI 动态生成 或 固定模板
 * 4. skill_route 日志事件：记录路由决策过程
 */

import { v4 as uuidv4 } from 'uuid';
import * as db from './db';
import { submitSandboxJob } from './cloudRunJobsClient';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE_ID = 'default';

// ─── In-memory store for pending async health queries ─────────────────────────
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
  skill_id?:        string;   // 可选：前端强制指定（优先级高于自动路由）
  callback_url?:    string;
}

export interface AgentDelivery {
  app:       string;
  recipient: string;
  action:    string;
}

export interface AgentResponse {
  request_id:   string;
  status:       'done' | 'processing';
  reply:        string;
  delivery:     AgentDelivery;
  reasoning?:   string;
  skill_route?: SkillRouteLog;  // 新增：路由决策日志
}

export interface SkillRouteLog {
  available_skills: { id: string; name: string; description: string }[];
  selected_id:      string | null;
  selected_name:    string | null;
  reason:           string;
}

// ─── Agent Profile ────────────────────────────────────────────────────────────

interface AgentProfile {
  id:               string;
  name:             string;
  role_desc:        string;
  reply_style:      string;
  service_flow:     string;
  taboos:           string[];
  reassurance_mode: 'ai' | 'template';
  reassurance_tpl:  string;
  skill_mode:       'auto' | 'manual';
  skill_ids:        string[];  // manual 模式下的 skill 白名单
}

async function loadAgentProfile(): Promise<AgentProfile> {
  try {
    const row = await db.getAsync<any>(
      'SELECT * FROM agent_profiles WHERE id = ?',
      [DEFAULT_PROFILE_ID]
    );
    if (!row) return defaultProfile();
    return {
      id:               row.id,
      name:             row.name || '服务助理',
      role_desc:        row.role_desc || '',
      reply_style:      row.reply_style || '',
      service_flow:     row.service_flow || '',
      taboos:           safeParseJson(row.taboos, []),
      reassurance_mode: (row.reassurance_mode === 'template' ? 'template' : 'ai'),
      reassurance_tpl:  row.reassurance_tpl || '',
      skill_mode:       (row.skill_mode === 'manual' ? 'manual' : 'auto'),
      skill_ids:        safeParseJson(row.skill_ids, []),
    };
  } catch {
    return defaultProfile();
  }
}

export async function saveAgentProfile(data: Partial<AgentProfile>): Promise<AgentProfile> {
  const now = Date.now();
  const existing = await db.getAsync<any>(
    'SELECT id FROM agent_profiles WHERE id = ?',
    [DEFAULT_PROFILE_ID]
  );
  if (existing) {
    await db.runAsync(
      `UPDATE agent_profiles SET name=?, role_desc=?, reply_style=?, service_flow=?,
       taboos=?, reassurance_mode=?, reassurance_tpl=?, skill_mode=?, skill_ids=?, updated_at=?
       WHERE id=?`,
      [
        data.name ?? '服务助理',
        data.role_desc ?? '',
        data.reply_style ?? '',
        data.service_flow ?? '',
        JSON.stringify(data.taboos ?? []),
        data.reassurance_mode ?? 'ai',
        data.reassurance_tpl ?? '',
        data.skill_mode ?? 'auto',
        JSON.stringify(data.skill_ids ?? []),
        now,
        DEFAULT_PROFILE_ID,
      ]
    );
  } else {
    await db.runAsync(
      `INSERT INTO agent_profiles (id,name,role_desc,reply_style,service_flow,taboos,
       reassurance_mode,reassurance_tpl,skill_mode,skill_ids,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        DEFAULT_PROFILE_ID,
        data.name ?? '服务助理',
        data.role_desc ?? '',
        data.reply_style ?? '',
        data.service_flow ?? '',
        JSON.stringify(data.taboos ?? []),
        data.reassurance_mode ?? 'ai',
        data.reassurance_tpl ?? '',
        data.skill_mode ?? 'auto',
        JSON.stringify(data.skill_ids ?? []),
        now, now,
      ]
    );
  }
  return loadAgentProfile();
}

function defaultProfile(): AgentProfile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: '服务助理',
    role_desc: '专业健康顾问助理，协助客户了解检查报告和日常健康管理',
    reply_style: '亲切、专业，回复简洁不超过200字',
    service_flow: '1. 判断是否为健康相关问题\n2. 健康问题优先调用对应 skill 深度分析\n3. 非健康问题礼貌回复并适当引导',
    taboos: ['不诊断疾病', '不推荐具体药物品牌', '不承诺治疗效果'],
    reassurance_mode: 'ai',
    reassurance_tpl: '',
    skill_mode: 'auto',
    skill_ids: [],
  };
}

// ─── 获取可用 skill 列表 ───────────────────────────────────────────────────────

async function getAvailableSkills(profile: AgentProfile): Promise<{ id: string; name: string; description: string }[]> {
  let skills: any[];
  if (profile.skill_mode === 'auto') {
    skills = await db.allAsync<any>(
      "SELECT id, name, description FROM skills WHERE status = 'published' ORDER BY name",
      []
    );
  } else {
    if (!profile.skill_ids.length) return [];
    const placeholders = profile.skill_ids.map(() => '?').join(',');
    skills = await db.allAsync<any>(
      `SELECT id, name, description FROM skills WHERE status = 'published' AND id IN (${placeholders}) ORDER BY name`,
      profile.skill_ids
    );
  }
  return skills.map(s => ({ id: s.id, name: s.name, description: s.description || '' }));
}

// ─── Config helpers ───────────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string> {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  return row?.value || '';
}

async function getGeminiKey(): Promise<string> {
  return (await getSetting('gemini_api_key')) || process.env.GEMINI_API_KEY || '';
}

// ─── Gemini Flash 通用调用 ────────────────────────────────────────────────────

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
      model:      'gemini-2.5-flash',
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

// ─── 1. Skill 自动路由（核心新功能）─────────────────────────────────────────

async function routeSkill(
  content: string,
  availableSkills: { id: string; name: string; description: string }[],
  apiKey: string,
): Promise<{ skillId: string | null; skillName: string | null; reason: string }> {
  if (!availableSkills.length) {
    return { skillId: null, skillName: null, reason: '无可用 skill，直接 AI 回复' };
  }

  const skillList = availableSkills
    .map((s, i) => `${i + 1}. ID="${s.id}" 名称="${s.name}" 描述="${s.description}"`)
    .join('\n');

  const systemPrompt = `你是一个智能路由助手。根据客户消息，从以下可用 skill 中选出最匹配的一个。
如果没有合适的 skill，返回 null。

可用 skill 列表：
${skillList}

只返回 JSON，不要有其他任何内容：
{"skill_id": "xxx-xxx-xxx" 或 null, "skill_name": "skill名称" 或 null, "reason": "简短的选择理由（一句话）"}`;

  try {
    const result = await callGeminiMessages(systemPrompt, [{ role: 'user', content }], apiKey, 512);
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in response');
    const parsed = JSON.parse(match[0]);
    const skillId = parsed.skill_id || null;
    const skillName = parsed.skill_name || null;
    // 验证 skill_id 确实在列表中
    if (skillId && !availableSkills.find(s => s.id === skillId)) {
      console.warn(`[AgentService] skill route returned unknown id=${skillId}, falling back to null`);
      return { skillId: null, skillName: null, reason: '路由返回了未知 skill，降级直接回复' };
    }
    console.log(`[AgentService] Skill route → id=${skillId} name=${skillName} reason=${parsed.reason}`);
    return { skillId, skillName, reason: parsed.reason || '' };
  } catch (err) {
    console.warn('[AgentService] Skill route failed, no skill selected:', err);
    return { skillId: null, skillName: null, reason: '路由失败，降级直接回复' };
  }
}

// ─── 2. 安抚消息生成 ──────────────────────────────────────────────────────────

async function buildReassuranceMessage(
  fromName: string,
  content: string,
  skillName: string | null,
  profile: AgentProfile,
  apiKey: string,
): Promise<string> {
  if (profile.reassurance_mode === 'template' && profile.reassurance_tpl) {
    return profile.reassurance_tpl.replace('{客户姓名}', fromName);
  }
  // AI 自动生成
  try {
    const prompt = `请为以下场景生成一条简短的安抚等待消息（20字以内，亲切自然）：
客户姓名：${fromName}
客户问题：${content.slice(0, 100)}
正在调用的服务：${skillName || '智能分析'}
要求：不要用 Markdown，直接给出消息内容`;
    const result = await callGeminiMessages('你是一个服务助理，正在给客户发等待提示。', [{ role: 'user', content: prompt }], apiKey, 100);
    return result.trim() || `${fromName}您好，稍等片刻，我正在为您分析～`;
  } catch {
    return `${fromName}您好，我正在为您分析，请稍等约 2 分钟，马上回复您～`;
  }
}

// ─── 3. 普通 AI 回复（无 skill）────────────────────────────────────────────────

async function handleDirectReply(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
  profile: AgentProfile,
  skillRouteLog: SkillRouteLog,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '', health_profile = '' } = req;
  const fromName = meta.from_name || '您';

  const tabooText = profile.taboos.length ? `\n\n禁忌：\n${profile.taboos.map(t => `- ${t}`).join('\n')}` : '';
  const systemPrompt = `你是${profile.name}。${profile.role_desc}

回复风格：${profile.reply_style || '亲切、专业'}
${profile.service_flow ? `\n服务流程：\n${profile.service_flow}` : ''}${tabooText}

当前正在通过${delivery.app}与客户${fromName}沟通。
${notes ? `\n关于该客户的备注：\n${notes}` : ''}
${health_profile ? `\n客户健康档案：\n${health_profile}` : ''}`;

  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024);
  return {
    request_id:   requestId,
    status:       'done',
    reply:        reply.trim(),
    delivery,
    reasoning:    '无匹配 skill，直接 AI 回复',
    skill_route:  skillRouteLog,
  };
}

// ─── 4. 调用 Skill（异步 Cloud Run Job）──────────────────────────────────────

async function handleSkillExecution(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
  profile: AgentProfile,
  skillId: string,
  skillName: string,
  skillRouteLog: SkillRouteLog,
  serviceUrl: string,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '', health_profile = '', session_id } = req;
  const fromName = meta.from_name || '您';

  pendingRequests.set(requestId, {
    callbackUrl: req.callback_url || '',
    sessionId:   session_id,
    delivery,
  });

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

  const jobCallbackUrl = serviceUrl
    ? `${serviceUrl}/api/v1/agent/job-callback/${requestId}`
    : '';

  try {
    await submitSandboxJob({
      skillId,
      userInputs:    { ticket: sandboxUserMessage },
      model:         'gemini-2.5-flash',
      aiKey:         apiKey,
      aiBaseUrl:     'https://generativelanguage.googleapis.com/v1beta/openai',
      callbackUrl:   jobCallbackUrl,
      sandboxSecret: process.env.SANDBOX_SECRET || 'sandbox-secret-2024',
      caseCount:     1,
      ticketMode:    true,
    });
    console.log(`[AgentService] Cloud Run Job submitted: skill=${skillName}(${skillId}), requestId=${requestId}`);
  } catch (err) {
    pendingRequests.delete(requestId);
    throw err;
  }

  // 生成安抚消息
  const reassuranceMsg = await buildReassuranceMessage(fromName, content, skillName, profile, apiKey);

  return {
    request_id:   requestId,
    status:       'processing',
    reply:        reassuranceMsg,
    delivery,
    reasoning:    `自动路由到 Skill「${skillName}」(${skillId})，异步执行中`,
    skill_route:  skillRouteLog,
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
    reasoning:  'Skill 执行完成',
  };

  console.log(`[AgentService] Job done for ${requestId}, output length=${agentOutput.length}`);

  if (!callbackUrl) {
    console.log(`[AgentService] No callback_url configured for ${requestId}`);
    return;
  }

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

  const app       = req.context.available_apps?.[0] || '企业微信';
  const recipient = req.context.current_recipient || req.meta.from_name || '';
  const delivery: AgentDelivery = { app, recipient, action: 'type_and_send' };

  console.log(`[AgentService] request_id=${requestId} session=${req.session_id} source=${req.source}`);

  // ── Step 1: 加载 Agent Profile ────────────────────────────────────────────
  const profile = await loadAgentProfile();
  console.log(`[AgentService] Profile loaded: skill_mode=${profile.skill_mode} reassurance=${profile.reassurance_mode}`);

  // ── Step 2: 获取可用 skill 列表 ────────────────────────────────────────────
  const availableSkills = await getAvailableSkills(profile);
  console.log(`[AgentService] Available skills: ${availableSkills.map(s => s.name).join(', ') || '(none)'}`);

  // ── Step 3: 决定使用哪个 skill ──────────────────────────────────────────────
  let selectedSkillId: string | null = null;
  let selectedSkillName: string | null = null;
  let routeReason = '';

  if (req.skill_id) {
    // 前端强制指定（优先级最高）
    const found = availableSkills.find(s => s.id === req.skill_id)
      || await db.getAsync<any>('SELECT id, name FROM skills WHERE id=?', [req.skill_id]);
    selectedSkillId   = req.skill_id;
    selectedSkillName = found?.name || req.skill_id;
    routeReason = `前端强制指定 skill_id=${req.skill_id}`;
    console.log(`[AgentService] skill_id forced by caller: ${selectedSkillId}`);
  } else if (availableSkills.length > 0) {
    // Agent 自动路由
    const route = await routeSkill(req.content, availableSkills, apiKey);
    selectedSkillId   = route.skillId;
    selectedSkillName = route.skillName;
    routeReason = route.reason;
  } else {
    routeReason = '无可用 skill，直接 AI 回复';
  }

  const skillRouteLog: SkillRouteLog = {
    available_skills: availableSkills,
    selected_id:      selectedSkillId,
    selected_name:    selectedSkillName,
    reason:           routeReason,
  };

  // ── Step 4: 执行 ─────────────────────────────────────────────────────────
  if (selectedSkillId && selectedSkillName) {
    return handleSkillExecution(
      req, apiKey, requestId, delivery,
      profile, selectedSkillId, selectedSkillName,
      skillRouteLog, serviceUrl
    );
  } else {
    return handleDirectReply(req, apiKey, requestId, delivery, profile, skillRouteLog);
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function safeParseJson<T>(str: string, fallback: T): T {
  try { return JSON.parse(str) as T; } catch { return fallback; }
}
