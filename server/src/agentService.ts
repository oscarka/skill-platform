/**
 * agentService.ts — Skill Platform 通用 Agent 服务 v2
 *
 * 功能：
 * 1. Gemini 3.6 Flash 轻量路由（chat vs health）< 2s
 * 2. 普通聊天：直接 AI 回复（带历史/备注）< 10s，同步返回
 * 3. 健康咨询：Agent Profile 决定用哪个 skill（自动路由），异步 callback
 * 4. 健康咨询（无匹配 skill）：直接 AI 回复（带健康档案），同步返回
 *
 * 新增（v2）：
 * - Agent Profile：从 DB 读取配置（角色/流程/禁忌/可用skill/安抚消息模式）
 * - 自动 Skill 路由：Gemini 从可用 skill 中选最合适的一个
 * - skill_route 字段：记录路由决策日志，透传给调用方
 */

import { v4 as uuidv4 } from 'uuid';
import * as db from './db';
import { submitSandboxJob } from './cloudRunJobsClient';
import { submitToSandboxService } from './sandboxServiceClient';

// ─── Agent Task Tracking ─────────────────────────────────────────────────────
// 每次外部消息处理都在 agent_tasks 表中生成一条记录，实现日志集中化

export async function createAgentTask(opts: {
  id: string; sessionId: string; userId: string;
  sourceChannel: string; inputContent: string; meta?: Record<string, any>;
}): Promise<void> {
  try {
    await db.runAsync(
      `INSERT INTO agent_tasks (id, session_id, user_id, source_channel, input_content, status, meta)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [opts.id, opts.sessionId, opts.userId, opts.sourceChannel,
       opts.inputContent, opts.meta ? JSON.stringify(opts.meta) : null]
    );
  } catch (err: any) { console.warn('[AgentTask] createAgentTask failed:', err.message); }
}

export async function updateAgentTask(id: string, fields: {
  status?: string; routeType?: string; skillId?: string;
  replyContent?: string; errorMessage?: string; endedAt?: number; durationMs?: number;
  jobTranscript?: string; contextSnapshot?: string; cuaEvents?: string;
}): Promise<void> {
  try {
    const sets: string[] = []; const vals: any[] = [];
    if (fields.status       !== undefined) { sets.push('status=?');        vals.push(fields.status); }
    if (fields.routeType    !== undefined) { sets.push('route_type=?');    vals.push(fields.routeType); }
    if (fields.skillId      !== undefined) { sets.push('skill_id=?');      vals.push(fields.skillId); }
    if (fields.replyContent !== undefined) { sets.push('reply_content=?'); vals.push(fields.replyContent); }
    if (fields.errorMessage !== undefined) { sets.push('error_message=?'); vals.push(fields.errorMessage); }
    if (fields.endedAt      !== undefined) { sets.push('ended_at=?');      vals.push(fields.endedAt); }
    if (fields.durationMs     !== undefined) { sets.push('duration_ms=?');      vals.push(fields.durationMs); }
    if (fields.jobTranscript  !== undefined) { sets.push('job_transcript=?');   vals.push(fields.jobTranscript); }
    if (fields.contextSnapshot!== undefined) { sets.push('context_snapshot=?'); vals.push(fields.contextSnapshot); }
    if (fields.cuaEvents      !== undefined) { sets.push('cua_events=?');       vals.push(fields.cuaEvents); }
    if (!sets.length) return;
    vals.push(id);
    await db.runAsync(`UPDATE agent_tasks SET ${sets.join(',')} WHERE id=?`, vals);
  } catch (err: any) { console.warn('[AgentTask] updateAgentTask failed:', err.message); }
}

export async function appendTaskEvent(taskId: string, eventType: string, payload?: Record<string, any>): Promise<void> {
  try {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      `INSERT INTO agent_task_events (id, task_id, event_type, payload, ts) VALUES (?, ?, ?, ?, ?)`,
      [eventId, taskId, eventType, payload ? JSON.stringify(payload) : null, Date.now()]
    );
  } catch (err: any) { console.warn('[AgentTask] appendTaskEvent failed:', err.message); }
}


// ─── LLMWiki Integration ──────────────────────────────────────────────────────
const LLMWIKI_BASE = process.env.LLMWIKI_BASE || '';

/**
 * 30 轮计数器：每个用户独立，满 30 轮自动触发 wiki sync
 * 对应 wiki_sync_trigger.cjs 的 WikiSyncTrigger 逻辑
 */
const syncCounters = new Map<string, number>();
const SYNC_COUNTER_LIMIT = 30;

/**
 * 后台静默写对话日志到 LLMWiki + 30 轮计数器自动 sync
 * fire-and-forget，不阻塞主流程
 */
function backgroundPostLog(userId: string, userMsg: string, aiReply: string): void {
  if (!LLMWIKI_BASE || !userId) {
    console.log(`[WikiLog] 跳过：LLMWIKI_BASE=${LLMWIKI_BASE ? '✓' : '✗'} userId=${userId || '(empty)'}`);
    return;
  }
  const logContent = `用户：${userMsg}\nAI：${aiReply}`;
  const url = `${LLMWIKI_BASE}/api/clients/${userId}/logs`;
  const body = JSON.stringify({
    type: 'wechat',
    content: logContent,
    title: `对话记录 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  });
  console.log(`[WikiLog] POST ${url} userId=${userId} contentLen=${logContent.length}`);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
    .then(res => {
      console.log(`[WikiLog] ✓ 日志写入成功 userId=${userId} HTTP ${res.status}`);
      // ── 30 轮计数器 ──
      const count = (syncCounters.get(userId) || 0) + 1;
      syncCounters.set(userId, count);
      console.log(`[WikiSync] 计数器 userId=${userId} count=${count}/${SYNC_COUNTER_LIMIT}`);
      if (count >= SYNC_COUNTER_LIMIT) {
        console.log(`[WikiSync] 📊 ${SYNC_COUNTER_LIMIT} 轮计数器触发 sync userId=${userId}`);
        syncCounters.set(userId, 0);
        triggerWikiSync(userId, 'counter_30');
      }
    })
    .catch(err => console.warn(`[WikiLog] ✗ 日志写入失败（不影响主流程）userId=${userId}:`, err.message));
}

/**
 * 后台触发 LLMWiki Wiki sync Pipeline（Skill 完成后调用）
 */
function triggerWikiSync(userId: string, reason: string): void {
  if (!LLMWIKI_BASE || !userId) {
    console.log(`[WikiSync] 跳过：LLMWIKI_BASE=${LLMWIKI_BASE ? '✓' : '✗'} userId=${userId || '(empty)'}`);
    return;
  }
  const url = `${LLMWIKI_BASE}/api/clients/${userId}/sync`;
  console.log(`[WikiSync] POST ${url} reason=${reason} userId=${userId}`);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),  // sync 可能需要较长时间（LLM 调用）
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      console.log(`[WikiSync] ✓ sync完成 userId=${userId} HTTP ${res.status} wikiUpdated=${(data as any).wikiUpdated ?? '?'}`);
    })
    .catch(err => console.warn(`[WikiSync] ✗ sync失败（不影响主流程）userId=${userId}:`, err.message));
}

/**
 * 自动从 LLMWiki 拉取用户的健康上下文（index.md 摘要 + user_profile）
 * 在 processAgentChat 入口处调用，作为公共服务层
 * 
 * 当用户不存在时（404），自动在 LLMWiki 创建档案，确保每个聊天用户都有 wiki
 */
async function fetchWikiContext(userId: string, query: string, fromName?: string): Promise<{ user_profile: string; health_wiki: string; mode: string }> {
  if (!LLMWIKI_BASE || !userId) {
    return { user_profile: '', health_wiki: '', mode: 'none' };
  }
  try {
    const url = `${LLMWIKI_BASE}/api/clients/${userId}/context-inject?query=${encodeURIComponent(query)}`;
    console.log(`[WikiContext] GET ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    
    if (res.status === 404) {
      // ── 用户不存在，自动创建 ──
      console.log(`[WikiContext] 用户 ${userId} 不存在，自动创建档案...`);
      try {
        const createRes = await fetch(`${LLMWIKI_BASE}/api/clients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: userId,           // 使用 agent 端的 user_id 作为 llmwiki client id
            name: fromName || userId,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (createRes.ok) {
          const created = await createRes.json() as any;
          console.log(`[WikiContext] ✓ 自动创建成功 id=${created.id} name=${created.name}`);
          // 再次尝试拉取上下文（创建后已有默认 wiki 模板）
          const retryRes = await fetch(url, { signal: AbortSignal.timeout(8_000) });
          if (retryRes.ok) {
            const data = await retryRes.json() as any;
            console.log(`[WikiContext] ✓ 创建后拉取成功 mode=${data.mode}`);
            return { user_profile: data.user_profile || '', health_wiki: data.health_wiki || '', mode: data.mode || 'full' };
          }
        } else {
          console.warn(`[WikiContext] 自动创建失败 HTTP ${createRes.status}`);
        }
      } catch (createErr: any) {
        console.warn(`[WikiContext] 自动创建异常:`, createErr.message);
      }
      return { user_profile: '', health_wiki: '', mode: 'auto_created' };
    }
    
    if (!res.ok) {
      console.log(`[WikiContext] HTTP ${res.status} — 跳过`);
      return { user_profile: '', health_wiki: '', mode: 'none' };
    }
    const data = await res.json() as any;
    console.log(`[WikiContext] ✓ mode=${data.mode} wiki=${(data.health_wiki || '').length}字 profile=${(data.user_profile || '').length}字`);
    return { user_profile: data.user_profile || '', health_wiki: data.health_wiki || '', mode: data.mode || 'full' };
  } catch (err: any) {
    console.warn(`[WikiContext] ✗ 拉取失败（不影响主流程）:`, err.message);
    return { user_profile: '', health_wiki: '', mode: 'error' };
  }
}

/**
 * 按需获取指定 Wiki 页面（供 Gemini function calling 调用）
 */
async function fetchWikiPage(userId: string, pageName: string): Promise<string> {
  if (!LLMWIKI_BASE || !userId) return '(无健康档案)';
  try {
    const url = `${LLMWIKI_BASE}/api/clients/${userId}/wiki`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return '(档案不存在)';
    const pages = await res.json() as Record<string, string>;
    return pages[pageName] || `(页面 ${pageName} 不存在)`;
  } catch (err: any) {
    console.warn(`[WikiPage] ✗ 获取 ${pageName} 失败:`, err.message);
    return '(获取失败)';
  }
}

// ─── Wiki function calling 工具定义 ─────────────────────────────────────────
const WIKI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_medical_history',
      description: '获取该客户的完整历史病史、化验结果和生理信号记录。当用户询问具体的检查结果、病史详情、化验指标时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_medication_plan',
      description: '获取该客户的完整用药方案、当前干预措施和监测目标。当用户询问具体用药、剂量调整、治疗方案时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ─── In-memory store for pending async health queries ─────────────────────────
const pendingRequests = new Map<string, {
  callbackUrl:  string;
  sessionId:    string;
  delivery:     { app: string; recipient: string; action: string };
  userId:       string;   // LLMWiki 用户 ID（用于日志回写和 sync）
  userContent:  string;   // 原始用户消息（用于写日志时配对）
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
  skill_route?: SkillRouteLog;  // 路由决策日志
}

export interface SkillRouteLog {
  available_skills: { id: string; name: string; description: string }[];
  selected_id:      string | null;
  selected_name:    string | null;
  reason:           string;
}

// ─── Agent Profile ────────────────────────────────────────────────────────────

const DEFAULT_PROFILE_ID = 'default';

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
  skill_ids:        string[];
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
  options?: { tools?: any[]; userId?: string },
): Promise<string> {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const tools = options?.tools;
  const userId = options?.userId || '';

  // 构造初始消息列表（可变，tool call 循环中会追加）
  const allMessages: any[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // 最多允许 3 轮 tool call（防止死循环）
  for (let round = 0; round < 4; round++) {
    const reqBody: any = {
      model:      'gemini-3.6-flash',
      messages:   allMessages,
      max_tokens: maxTokens,
      stream:     false,
    };
    if (tools && tools.length > 0 && round < 3) {
      reqBody.tools = tools;
    }

    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const finishReason: string = choice?.finish_reason || 'unknown';
    const usage = data.usage || {};
    const assistantMsg = choice?.message;

    // ─── 日志 ──────────────────────────────────────────────────────────────
    const contentLen = (assistantMsg?.content || '').length;
    const toolCalls = assistantMsg?.tool_calls || [];
    const logLevel = finishReason !== 'stop' && finishReason !== 'tool_calls' ? 'WARN' : 'INFO';
    console.log(
      `[Gemini][${logLevel}] round=${round} finish_reason=${finishReason}` +
      ` prompt_tokens=${usage.prompt_tokens ?? '?'}` +
      ` completion_tokens=${usage.completion_tokens ?? '?'}` +
      ` content_len=${contentLen} tool_calls=${toolCalls.length}` +
      ` max_tokens=${maxTokens}` +
      (contentLen > 0 ? ` preview="${(assistantMsg?.content || '').slice(0, 60).replace(/\n/g, '↵')}..."` : '')
    );
    if (finishReason === 'MAX_TOKENS' || finishReason === 'max_tokens') {
      console.warn(`[Gemini] ⚠️ 输出被截断！content_len=${contentLen}`);
    }

    // ─── 如果没有 tool calls，返回文本内容 ────────────────────────────────
    if (toolCalls.length === 0) {
      const content = assistantMsg?.content || '';
      if (!content) throw new Error('Gemini returned empty content');
      return content;
    }

    // ─── 处理 tool calls ─────────────────────────────────────────────────
    console.log(`[Gemini] 🔧 ${toolCalls.length} tool call(s): ${toolCalls.map((tc: any) => tc.function?.name).join(', ')}`);
    allMessages.push(assistantMsg); // 把 assistant 的 tool_call 消息加入

    for (const tc of toolCalls) {
      const fnName = tc.function?.name || '';
      let result = '';

      if (fnName === 'get_medical_history') {
        result = await fetchWikiPage(userId, 'medical_history.md');
        console.log(`[Gemini] 📄 get_medical_history → ${result.length}字`);
      } else if (fnName === 'get_medication_plan') {
        result = await fetchWikiPage(userId, 'medication_plan.md');
        console.log(`[Gemini] 📄 get_medication_plan → ${result.length}字`);
      } else {
        result = `未知工具: ${fnName}`;
      }

      allMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
    // 继续下一轮，让 Gemini 基于 tool 结果生成回复
  }

  throw new Error('Tool call loop exceeded max rounds');
}

// ─── 1. Gemini 3.6 Flash 轻量路由（chat vs health） ──────────────────────────

// Route result also carries timing and prompt for logging
export interface RouteResult { type: 'chat' | 'health'; durationMs: number; systemPrompt: string; userMsg: string; rawResult: string; model: string; }

async function routeMessage(content: string, notes: string, history: { role: string; content: string }[], apiKey: string): Promise<RouteResult> {
  const systemPrompt = `你是一个智能分诊助手。根据客户消息和近期对话历史判断属于哪一类：
- "chat"：普通问候、闲聊、询问服务范围/是否可以咨询、非健康相关问题、一般性商务咨询、价格询问等
- "health"：客户本人或家人有具体的健康症状/指标需要分析，包括：健康症状描述、体检报告解读、饮食调理、用药咨询、身体指标数值解读等

注意：
- "可以问家人问题吗""你们能帮我看xx吗"等询问服务能力的句子属于"chat"，不是"health"。
- 如果当前消息较短（如纠正错别字、补充说明），请结合近期对话历史判断真实意图。
只返回 JSON，不要有其他任何内容：{"type":"chat"} 或 {"type":"health"}`;

  const recentHistory = history.slice(-20).map(h => `${h.role === 'user' ? '客户' : '助手'}：${h.content}`).join('\n');
  const userMsg = `客户备注：${notes || '（无）'}\n${recentHistory ? `近期对话：\n${recentHistory}\n` : ''}客户最新消息：${content}`;

  const t0 = Date.now();
  try {
    const result = await callGeminiMessages(systemPrompt, [{ role: 'user', content: userMsg }], apiKey, 1024);
    const durationMs = Date.now() - t0;
    const match = result.match(/"type"\s*:\s*"(chat|health)"/);
    const type = match?.[1] as 'chat' | 'health' | undefined;
    console.log(`[AgentService] Route result raw="${result.trim()}" → type=${type || 'chat(fallback)'} (${durationMs}ms)`);
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    return { type: type || 'chat', durationMs, systemPrompt, userMsg, rawResult: result.trim(), model };
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.warn('[AgentService] Route call failed, defaulting to chat:', err);
    return { type: 'chat', durationMs, systemPrompt, userMsg, rawResult: '(error)', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' };
  }
}

// ─── 2. 自动 Skill 路由（从可用 skill 中选最合适的一个）────────────────────────

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

async function routeSkill(
  content: string,
  availableSkills: { id: string; name: string; description: string }[],
  history: { role: string; content: string }[],
  apiKey: string,
): Promise<{ skillId: string | null; skillName: string | null; reason: string }> {
  if (!availableSkills.length) {
    return { skillId: null, skillName: null, reason: '无可用 skill，直接 AI 回复' };
  }

  // 描述截断 80 字，避免 prompt 过长
  const skillList = availableSkills
    .map((s, i) => `${i + 1}. ID="${s.id}" 名称="${s.name}" 描述="${s.description.slice(0, 80)}"`)
    .join('\n');

  const recentHistory = history.slice(-20).map(h => `${h.role === 'user' ? '客户' : '助手'}：${h.content}`).join('\n');
  const contextMsg = `${recentHistory ? `近期对话：\n${recentHistory}\n` : ''}客户最新消息：${content}`;

  const systemPrompt = `你是一个智能路由助手。根据客户消息和对话历史，从以下可用 skill 中选出最匹配的一个。如果没有合适的 skill，返回 null。
如果当前消息较短（如纠正错别字、补充说明），请结合近期对话历史判断真实意图。

可用 skill 列表：
${skillList}

只返回 JSON，不要有其他任何内容：{"skill_id": "xxx" 或 null, "skill_name": "xxx" 或 null, "reason": "一句话理由"}`;

  try {
    const result = await callGeminiMessages(systemPrompt, [{ role: 'user', content: contextMsg }], apiKey, 1024);
    console.log(`[AgentService] Skill route raw response: "${result.slice(0, 300)}"`);

    // 直接找第一个 { 和最后一个 }，无视 markdown 代码块包裹
    const jsonStart = result.indexOf('{');
    const jsonEnd   = result.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      throw new Error(`no JSON object found in response: "${result.slice(0, 100)}"`);
    }
    const parsed   = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
    const skillId   = parsed.skill_id   || null;
    const skillName = parsed.skill_name || null;
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

// ─── 3. 安抚消息生成 ──────────────────────────────────────────────────────────

async function buildReassuranceMessage(
  fromName: string,
  content: string,
  skillName: string | null,
  profile: AgentProfile,
  _apiKey: string,
): Promise<string> {
  if (profile.reassurance_mode === 'template' && profile.reassurance_tpl) {
    return profile.reassurance_tpl.replace('{客户姓名}', fromName);
  }
  // AI 模式：用智能模板（基于 skillName 动态生成，稳定可靠）
  // 避免直接调 Gemini 生成短句——maxTokens=100 时返回结果不稳定
  const verb = skillName ? `为您进行「${skillName}」分析` : '为您分析';
  return `${fromName}您好，我正在${verb}，请稍等约 2 分钟，马上回复您～`;
}

// ─── 4. 普通聊天：直接 AI 回复 ────────────────────────────────────────────────

async function handleChatReply(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
  profile: AgentProfile,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '' } = req;
  const wikiCtx = (req as any)._wikiContext as { user_profile: string; health_wiki: string } | undefined;
  const fromName = meta.from_name || '您';
  const { app } = delivery;

  const tabooText = profile.taboos.length ? `\n\n禁忌：\n${profile.taboos.map(t => `- ${t}`).join('\n')}` : '';
  const profileBlock = wikiCtx?.user_profile ? `\n\n【客户画像】\n${wikiCtx.user_profile}` : '';
  const healthBlock = wikiCtx?.health_wiki ? `\n\n【健康档案摘要】\n${wikiCtx.health_wiki}` : '';
  const systemPrompt = `你是${profile.name}，${profile.role_desc || '专业的健康顾问助理'}，正在通过${app}与客户${fromName}沟通。

回复风格：${profile.reply_style || '亲切、专业，回复简洁，通常不超过150字'}
${profile.service_flow ? `\n服务流程：\n${profile.service_flow}` : ''}${tabooText}

关于该客户的备注信息：
${notes || '（无特殊备注）'}${profileBlock}${healthBlock}

任务：用自然、亲切的语气回复客户消息。
要求：
- 不要使用 Markdown 格式（不要**加粗**、不要#标题、不要列表符号）
- 直接称呼客户为"${fromName}"
- 如客户涉及具体健康问题，告知正在为其准备专业分析，请稍等`;

  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024,
    { tools: wikiCtx?.health_wiki ? WIKI_TOOLS : undefined, userId: meta.user_id });

  // ── LLMWiki: 后台写日志 ──
  backgroundPostLog(meta.user_id, content, reply.trim());

  return {
    request_id: requestId,
    status:     'done',
    reply:      reply.trim(),
    delivery,
    reasoning:  '普通聊天，Gemini 直接回复',
  };
}

// ─── 5. 健康咨询（无匹配 skill）：带档案的直接 AI 回复 ──────────────────────

async function handleHealthDirect(
  req: AgentChatRequest,
  apiKey: string,
  requestId: string,
  delivery: AgentDelivery,
  profile: AgentProfile,
  skillRouteLog: SkillRouteLog,
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '' } = req;
  const wikiCtx = (req as any)._wikiContext as { user_profile: string; health_wiki: string } | undefined;
  const fromName = meta.from_name || '您';

  const tabooText = profile.taboos.length ? `\n\n禁忌：\n${profile.taboos.map(t => `- ${t}`).join('\n')}` : '';
  const profileBlock = wikiCtx?.user_profile ? `\n\n【客户画像】\n${wikiCtx.user_profile}` : '';
  const healthBlock = wikiCtx?.health_wiki ? `\n\n【健康档案摘要】\n${wikiCtx.health_wiki}` : '';
  const systemPrompt = `你是${profile.name}，${profile.role_desc || '专业的健康顾问'}，根据客户的健康档案和问题提供专业且个性化的建议。
回复风格：${profile.reply_style || '亲切专业，回复控制在300字以内'}${tabooText}${profileBlock}${healthBlock}

要求：
- 不要使用 Markdown 格式
- 亲切专业，直接称呼客户为"${fromName}"
- 如无健康档案，基于对话内容给出通用建议`;

  const contextBlock = [
    notes ? `【客户备注】\n${notes}` : '',
    `【当前问题】\n${content}`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: contextBlock },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 2048,
    { tools: wikiCtx?.health_wiki ? WIKI_TOOLS : undefined, userId: meta.user_id });

  // ── LLMWiki: 后台写日志 ──
  backgroundPostLog(meta.user_id, content, reply.trim());

  return {
    request_id:  requestId,
    status:      'done',
    reply:       reply.trim(),
    delivery,
    reasoning:   '健康咨询（无匹配 Skill），带档案直接 AI 回复',
    skill_route: skillRouteLog,
  };
}

// ─── 6. 健康咨询（有匹配 skill）：提交 Cloud Run Job ────────────────────────

async function handleHealthSkill(
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
  const { content, meta, history = [], notes = '', session_id } = req;
  const wikiCtx = (req as any)._wikiContext as { user_profile: string; health_wiki: string } | undefined;
  const fromName = meta.from_name || '您';

  pendingRequests.set(requestId, {
    callbackUrl:  req.callback_url || '',
    sessionId:    session_id,
    delivery,
    userId:       meta.user_id || '',      // LLMWiki: 用于日志回写
    userContent:  content,                 // LLMWiki: 原始用户消息
  });

  const recentHistory = history.slice(-20)
    .map(h => `${h.role === 'user' ? '客户' : '助手'}：${h.content}`)
    .join('\n');

  const sandboxUserMessage = [
    notes          ? `【客户备注】\n${notes}` : '',
    recentHistory  ? `【近期对话记录】\n${recentHistory}` : '',
    wikiCtx?.user_profile ? `【客户画像】\n${wikiCtx.user_profile}` : '',
    wikiCtx?.health_wiki  ? `【健康档案】\n${wikiCtx.health_wiki}` : '',
    `【当前问题】\n${content}`,
    `\n请以亲切专业的口吻回复，不要使用 Markdown 格式，称呼客户为"${fromName}"。`,
  ].filter(Boolean).join('\n\n');

  // 记录发给 Skill 的完整上下文（含 profile/wiki 注入情况）
  void appendTaskEvent(requestId, 'skill_input', {
    message_preview: sandboxUserMessage.slice(0, 3000), // 扩大到3000字，便于完整审查
    message_chars: sandboxUserMessage.length,
    has_wiki: !!(wikiCtx?.health_wiki),
    has_profile: !!(wikiCtx?.user_profile),
    history_count: history.length,
    wiki_chars: wikiCtx?.health_wiki?.length || 0,
    profile_chars: wikiCtx?.user_profile?.length || 0,
  });

  const jobCallbackUrl = serviceUrl
    ? `${serviceUrl}/api/v1/agent/job-callback/${requestId}`
    : '';

  // ── 路由策略（和工单系统一致）──────────────────────────────────────────────────
  // approved skill + SANDBOX_SERVICE_URL 已配置 → Sandbox Service（热实例，冷启动 <100ms）
  // 其他 → Cloud Run Job（冷启动 8-15s）
  const sandboxServiceUrl = process.env.SANDBOX_SERVICE_URL || '';
  const skillRow = await db.getAsync<any>('SELECT status, preferred_model, mcp_names FROM skills WHERE id=?', [skillId]);
  const isApproved = skillRow?.status === 'approved' || skillRow?.status === 'published';
  const effectiveModel = skillRow?.preferred_model || 'gemini-3.6-flash';

  try {
    if (isApproved && sandboxServiceUrl) {
      // ── Sandbox Service（持久热实例）────────────────────────────────────
      console.log(`[AgentService] Sandbox Service submitted: skill=${skillName}(${skillId}), requestId=${requestId}`);
      await submitToSandboxService(sandboxServiceUrl, {
        skillId,
        userInputs:    { ticket: sandboxUserMessage },
        model:          effectiveModel,
        aiKey:          apiKey,
        aiBaseUrl:      'https://generativelanguage.googleapis.com/v1beta/openai',
        callbackUrl:    jobCallbackUrl,
        sandboxSecret:  process.env.SANDBOX_SECRET || 'sandbox-secret-2024',
        caseCount:      1,
        ticketMode:     true,
      });
    } else {
      // ── Cloud Run Job（按需冷启动）──────────────────────────────────────
      console.log(`[AgentService] Cloud Run Job submitted: skill=${skillName}(${skillId}), requestId=${requestId} (status=${skillRow?.status}, serviceUrl=${sandboxServiceUrl ? 'set' : 'unset'})`);
      await submitSandboxJob({
        skillId,
        userInputs:    { ticket: sandboxUserMessage },
        model:          effectiveModel,
        aiKey:          apiKey,
        aiBaseUrl:      'https://generativelanguage.googleapis.com/v1beta/openai',
        callbackUrl:    jobCallbackUrl,
        sandboxSecret:  process.env.SANDBOX_SECRET || 'sandbox-secret-2024',
        caseCount:      1,
        ticketMode:     true,
      });
    }
  } catch (err) {
    pendingRequests.delete(requestId);
    throw err;
  }

  // 安抚消息
  const reassuranceMsg = await buildReassuranceMessage(fromName, content, skillName, profile, apiKey);

  return {
    request_id:  requestId,
    status:      'processing',
    reply:       reassuranceMsg,
    delivery,
    reasoning:   `自动路由到 Skill「${skillName}」(${skillId})，异步执行中`,
    skill_route: skillRouteLog,
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

  const { callbackUrl, sessionId, delivery, userId, userContent } = pending;
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

  // ── 更新 agent_task 为完成状态（含完整 transcript）──
  const transcriptJson = jobResult?.transcript ? JSON.stringify(jobResult.transcript) : null;
  void updateAgentTask(requestId, {
    status: 'done',
    replyContent: agentOutput.slice(0, 500),
    endedAt: Date.now(),
    ...(transcriptJson ? { jobTranscript: transcriptJson } : {}),
  });
  void appendTaskEvent(requestId, 'skill_done', {
    outputLen: agentOutput.length,
    output_preview: agentOutput.slice(0, 400),
  });
  void appendTaskEvent(requestId, 'reply_sent', {
    reply: agentOutput.slice(0, 600),
    replyLen: agentOutput.length,
    channel: delivery.app,
    recipient: delivery.recipient,
    delivery_action: delivery.action,
    cua_url: process.env.CUA_SEND_URL || '',
  });

  // ── LLMWiki: Skill 完成后写日志 + 触发 sync + 重置计数器 ──
  backgroundPostLog(userId, userContent, agentOutput);
  triggerWikiSync(userId, `skill_complete:${requestId}`);
  syncCounters.set(userId, 0); // Skill sync 已触发，重置30轮计数器

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
  const taskStartMs = Date.now();

  const app       = req.context.available_apps?.[0] || '企业微信';
  const recipient = req.context.current_recipient || req.meta.from_name || '';
  const delivery: AgentDelivery = { app, recipient, action: 'type_and_send' };

  const userId      = req.meta?.user_id || '';
  const sessionId   = req.session_id || userId;
  const srcChannel  = (req as any).source_channel || req.source || 'wecom';

  console.log(`[AgentService] request_id=${requestId} session=${sessionId} source=${srcChannel}`);

  // ── 创建 agent_task 记录（await 确保写入，不受 fire-and-forget 影响）──────────
  await createAgentTask({
    id: requestId, sessionId, userId, sourceChannel: srcChannel,
    inputContent: req.content,
    meta: { from_name: req.meta?.from_name, employee: (req.meta as any)?.employee },
  });
  // ── 存完整上下文快照（历史、备注）供日志查看 ─────────────────────────────────
  void updateAgentTask(requestId, {
    contextSnapshot: JSON.stringify({
      history: req.history || [],
      notes: req.notes || '',
      history_count: (req.history || []).length,
      from_name: req.meta?.from_name,
      session_id: req.session_id,
    }),
  });

  void appendTaskEvent(requestId, 'message_received', {
    content: req.content.slice(0, 300),
    source: srcChannel,
    from_name: req.meta?.from_name || '',
    history_count: (req.history || []).length,
    has_notes: !!(req.notes),
  });

  // ── Step 0: 自动从 LLMWiki 拉取健康上下文（公共服务层）─────────────────────
  // 若用户不存在，自动在 LLMWiki 创建档案（使用 from_name 作为姓名）
  if (userId && LLMWIKI_BASE) {
    let wikiCtx = await fetchWikiContext(userId, req.content, req.meta?.from_name);

    // ── 过滤纯模板 profile（只有 HTML 注释和"暂无记录"，无实质内容）──────────────
    const profileMeaningful = (wikiCtx.user_profile || '')
      .replace(/<!--[\s\S]*?-->/g, '')   // 去掉 HTML 注释块
      .replace(/暂无记录。?/g, '')          // 去掉占位符
      .replace(/#+\s[^\n]*/g, '')         // 去掉标题行
      .replace(/\s+/g, ' ')
      .trim();
    if (profileMeaningful.length < 30) {
      wikiCtx = { ...wikiCtx, user_profile: '' };
      console.log(`[AgentService] Profile 为纯模板，过滤掉（有效字符=${profileMeaningful.length}）`);
    }

    (req as any)._wikiContext = wikiCtx;
    console.log(`[AgentService] WikiContext injected: mode=${wikiCtx.mode} wiki=${wikiCtx.health_wiki.length}字 profile=${wikiCtx.user_profile.length}字`);

  void appendTaskEvent(requestId, 'wiki_fetched', {
    mode: wikiCtx.mode,
    wiki_chars: wikiCtx.health_wiki.length,
    profile_chars: wikiCtx.user_profile.length,
    profile_preview: wikiCtx.user_profile.slice(0, 400),
    wiki_preview: wikiCtx.health_wiki.slice(0, 400),
  });

    // ── 新用户 + 带历史对话 → 把历史写入日志并立即 sync ──
    if ((wikiCtx.mode === 'auto_created' || wikiCtx.mode === 'new_user') && req.history && req.history.length > 0) {
      console.log(`[AgentService] 新用户带历史 ${req.history.length} 条，批量写入日志并 sync`);
      // 将 history 配对成 user+assistant 日志
      const logs: { type: string; content: string; title: string }[] = [];
      for (let i = 0; i < req.history.length; i += 2) {
        const userMsg = req.history[i]?.content || '';
        const aiMsg = req.history[i + 1]?.content || '';
        if (userMsg) {
          logs.push({
            type: 'wechat',
            content: `用户：${userMsg}${aiMsg ? `\nAI：${aiMsg}` : ''}`,
            title: `历史对话 ${Math.floor(i / 2) + 1}`,
          });
        }
      }
      if (logs.length > 0) {
        // 批量写入
        fetch(`${LLMWIKI_BASE}/api/clients/${userId}/logs/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs }),
          signal: AbortSignal.timeout(10_000),
        })
          .then(res => {
            console.log(`[WikiLog] ✓ 历史日志批量写入 ${logs.length} 条 HTTP ${res.status}`);
            // 写入成功后立即 sync
            triggerWikiSync(userId, 'new_user_with_history');
          })
          .catch(err => console.warn(`[WikiLog] ✗ 历史日志写入失败:`, err.message));
      }
    }
  }

  // ── Step 1: chat vs health 路由 ─────────────────────────────────────────────
  void updateAgentTask(requestId, { status: 'routing' });
  const routeResult = await routeMessage(req.content, req.notes || '', req.history || [], apiKey);
  const routeType = routeResult.type;
  console.log(`[AgentService] → routed as: ${routeType} (${routeResult.durationMs}ms)`);
  void appendTaskEvent(requestId, 'route_decided', {
    routeType,
    durationMs: routeResult.durationMs,
    systemPrompt: routeResult.systemPrompt,
    userMsg: routeResult.userMsg.slice(0, 800),
    rawResult: routeResult.rawResult,
    model: routeResult.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash', // 使用实际模型名
  });

  // ── Step 2: 普通聊天不走 skill ──────────────────────────────────────────────
  if (routeType !== 'health') {
    void updateAgentTask(requestId, { status: 'executing', routeType: 'chat' });
    const profile = await loadAgentProfile();
    const chatResult = await handleChatReply(req, apiKey, requestId, delivery, profile);
    const endMs = Date.now();
    void updateAgentTask(requestId, { status: 'done', routeType: 'chat', replyContent: chatResult.reply?.slice(0, 500), endedAt: endMs, durationMs: endMs - taskStartMs });
    void appendTaskEvent(requestId, 'reply_sent', { replyLen: chatResult.reply?.length, reply: chatResult.reply?.slice(0, 600), channel: delivery.app, recipient: delivery.recipient });
    return chatResult;
  }

  // ── Step 3: 健康问题 — 加载 Agent Profile + 可用 skill ─────────────────────
  const profile = await loadAgentProfile();
  console.log(`[AgentService] Profile: skill_mode=${profile.skill_mode} reassurance=${profile.reassurance_mode}`);

  const availableSkills = await getAvailableSkills(profile);
  console.log(`[AgentService] Available skills: ${availableSkills.map(s => s.name).join(', ') || '(none)'}`);

  // ── Step 4: 决定使用哪个 skill ──────────────────────────────────────────────
  let selectedSkillId: string | null = null;
  let selectedSkillName: string | null = null;
  let routeReason = '';

  if (req.skill_id) {
    // 前端强制指定（优先级最高）
    const found = availableSkills.find(s => s.id === req.skill_id)
      || await db.getAsync<any>('SELECT id, name FROM skills WHERE id=?', [req.skill_id]);
    selectedSkillId   = req.skill_id;
    selectedSkillName = (found as any)?.name || req.skill_id;
    routeReason = `前端强制指定 skill_id=${req.skill_id}`;
    console.log(`[AgentService] skill_id forced by caller: ${selectedSkillId}`);
  } else {
    // Agent 自动路由
    const route = await routeSkill(req.content, availableSkills, req.history || [], apiKey);
    selectedSkillId   = route.skillId;
    selectedSkillName = route.skillName;
    routeReason = route.reason;
  }

  const skillRouteLog: SkillRouteLog = {
    available_skills: availableSkills,
    selected_id:      selectedSkillId,
    selected_name:    selectedSkillName,
    reason:           routeReason,
  };

  // ── Step 5: 执行 ─────────────────────────────────────────────────────────────
  void appendTaskEvent(requestId, 'skill_selected', {
    skillId: selectedSkillId,
    skillName: selectedSkillName,
    reason: routeReason,
    available_skills: availableSkills.map(s => ({ id: s.id, name: s.name, description: (s as any).description?.slice(0, 100) || '' })),
  });
  void updateAgentTask(requestId, { status: 'executing', routeType: 'health', skillId: selectedSkillId || undefined });

  if (selectedSkillId && selectedSkillName) {
    const skillDesc = availableSkills.find(s => s.id === selectedSkillId);
    const _wikiForLog = (req as any)._wikiContext as { user_profile: string; health_wiki: string } | undefined;
    void appendTaskEvent(requestId, 'skill_started', {
      skillId: selectedSkillId,
      skillName: selectedSkillName,
      description: (skillDesc as any)?.description?.slice(0, 200) || '',
      context_summary: [
        _wikiForLog?.user_profile ? `用户画像 ${_wikiForLog.user_profile.length}字` : '无用户画像',
        _wikiForLog?.health_wiki  ? `健康档案 ${_wikiForLog.health_wiki.length}字` : '无健康档案',
        `历史 ${(req.history || []).length} 条`,
      ].join(' · '),
    });
    const skillResult = await handleHealthSkill(
      req, apiKey, requestId, delivery,
      profile, selectedSkillId, selectedSkillName,
      skillRouteLog, serviceUrl
    );
    void appendTaskEvent(requestId, 'reassurance_sent', { reply: skillResult.reply?.slice(0, 200) });
    return skillResult;
  } else {
    const directResult = await handleHealthDirect(req, apiKey, requestId, delivery, profile, skillRouteLog);
    const endMs = Date.now();
    void updateAgentTask(requestId, { status: 'done', routeType: 'health_direct', replyContent: directResult.reply?.slice(0, 500), endedAt: endMs, durationMs: endMs - taskStartMs });
    void appendTaskEvent(requestId, 'reply_sent', { replyLen: directResult.reply?.length, reply: directResult.reply?.slice(0, 600), channel: delivery.app, recipient: delivery.recipient });
    return directResult;
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function safeParseJson<T>(str: string, fallback: T): T {
  try { return JSON.parse(str) as T; } catch { return fallback; }
}
