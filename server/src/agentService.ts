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

import { EventEmitter } from 'events';

// ─── Agent Task Tracking ─────────────────────────────────────────────────────
// 每次外部消息处理都在 agent_tasks 表中生成一条记录，实现日志集中化
// SSE real-time push via EventEmitter
export const taskEventBus = new EventEmitter();
taskEventBus.setMaxListeners(50); // allow many SSE connections

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
    const ts = Date.now();
    await db.runAsync(
      `INSERT INTO agent_task_events (id, task_id, event_type, payload, ts) VALUES (?, ?, ?, ?, ?)`,
      [eventId, taskId, eventType, payload ? JSON.stringify(payload) : null, ts]
    );
    // Push to SSE subscribers in real-time
    taskEventBus.emit(`task:${taskId}`, { id: eventId, event_type: eventType, payload, ts });
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
 * 公开接口：写一条日志到 LLMWiki（用于报告确认等场景）
 * 与 backgroundPostLog 不同，这是 async/await 模式，调用方可 await
 */
export async function writeWikiLog(userId: string, content: string, type: string = 'wechat', title?: string): Promise<void> {
  if (!LLMWIKI_BASE || !userId) {
    console.log(`[WriteWikiLog] 跳过：LLMWIKI_BASE=${LLMWIKI_BASE ? '✓' : '✗'} userId=${userId || '(empty)'}`);
    return;
  }
  const url = `${LLMWIKI_BASE}/api/clients/${userId}/logs`;
  const body = JSON.stringify({
    type,
    content,
    title: title || `日志 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  });
  console.log(`[WriteWikiLog] POST ${url} userId=${userId} type=${type} contentLen=${content.length}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLMWiki log write failed: HTTP ${res.status} ${errText}`);
  }
  console.log(`[WriteWikiLog] ✓ 写入成功 userId=${userId} HTTP ${res.status}`);
}

/**
 * 后台触发 LLMWiki Wiki sync Pipeline（Skill 完成后调用）
 */
export function triggerWikiSyncPublic(userId: string, reason: string): void {
  triggerWikiSync(userId, reason);
}

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
  // ── Step 6 (v2): query_ticket — Agent 按需查询工单/报告内容 ───────────────────
  {
    type: 'function' as const,
    function: {
      name: 'query_ticket',
      description: '查询用户最近一条工单或分析报告的详细内容。当用户询问报告细节、分析结果、工单进度时调用。返回报告正文、状态和工单ID。',
      parameters: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: '用户ID，从对话上下文获取',
          },
        },
        required: [],
      },
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
  skillName:    string;   // Task 5: skill 名称（发链接消息时显示）
  fromName:     string;   // Task 5: 用户称呼
}>();

// ─── 工单创建防抖锁（防止短时间内并发请求重复建单）──────────────────────────
// key = "${userId}:${skillId}"，8秒内同一组合只允许创建一次
const _ticketCreationLocks = new Set<string>();

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
  options?: {
    tools?: any[];
    userId?: string;
    onToolCall?: (name: string, args: any, result: string) => void;  // Step 6: tool call 事件回调
  },
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
      } else if (fnName === 'query_ticket') {
        // Step 6 (v2): 查询工单/报告内容
        const ticket = await db.getAsync<any>(
          `SELECT id, skill_id, skill_name, status, raw_result, report_url, created_at
           FROM tickets
           WHERE created_by=? AND status IN ('done','processing','submitted','waiting_input')
           ORDER BY created_at DESC LIMIT 1`,
          [userId || ''],
        ).catch(() => null);
        if (ticket) {
          result = JSON.stringify({
            ticket_id:    ticket.id,
            skill_name:   ticket.skill_name || ticket.skill_id,
            status:       ticket.status,
            report:       ticket.raw_result || '（报告尚未生成）',
            report_url:   ticket.report_url || null,
            created_at:   ticket.created_at,
          });
          console.log(`[Gemini] 📋 query_ticket → ticket_id=${ticket.id} status=${ticket.status} report_len=${ticket.raw_result?.length || 0}`);
        } else {
          result = JSON.stringify({ found: false, message: '未找到近期工单' });
          console.log(`[Gemini] 📋 query_ticket → 无工单 userId=${userId}`);
        }
        options?.onToolCall?.(fnName, { user_id: userId }, result);
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

// ─── v2 架构：Step2 — 路由前上下文预查询 ─────────────────────────────────────

export interface ContextSnapshot {
  // 守卫状态
  activeGuard: any | null;         // 当前 session 的活跃守卫行（null=无）
  // 工单状态（最近7天内任意skill的最新工单）
  recentTicket: any | null;        // null=无最近工单
}

/**
 * 在路由AI调用之前，一次性查好守卫和工单状态。
 * 后续所有步骤（路由、守卫、Agent上下文组装）直接使用，不重复查DB。
 */
async function queryContextSnapshot(
  sessionId: string | null,
  userId: string | null,
): Promise<ContextSnapshot> {
  const nowMs = Date.now();
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;

  // 查守卫：当前 session 的活跃守卫（最新一条）
  let activeGuard: any | null = null;
  if (sessionId) {
    activeGuard = await db.getAsync<any>(
      `SELECT * FROM skill_confirm_guards
       WHERE session_id=? AND status='active' AND expires_at>?
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, nowMs],
    ).catch(() => null);
  }

  // 查工单：该用户7天内最新工单（任意skill）
  let recentTicket: any | null = null;
  if (userId) {
    recentTicket = await db.getAsync<any>(
      `SELECT t.*, tr.raw_result, tr.report_url
       FROM tickets t
       LEFT JOIN ticket_results tr ON tr.ticket_id = t.id
       WHERE t.created_by=? AND t.created_at>? AND t.status != 'error'
       ORDER BY t.created_at DESC LIMIT 1`,
      [userId, sevenDaysAgo],
    ).catch(() => null);
  }

  return { activeGuard, recentTicket };
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
- 当客户明确要求使用某个服务或分析功能时（如"帮我做营养分析""帮我做AI营养师""解读报告""做营养评估"），属于"health"。客户在请求执行一项具体服务，不是在问能不能做。
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
): Promise<{ skillId: string | null; skillName: string | null; reason: string; confidence: 'high' | 'low' }> {
  if (!availableSkills.length) {
    return { skillId: null, skillName: null, reason: '无可用 skill，直接 AI 回复', confidence: 'low' };
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

同时判断用户意图是否明确到可以主动推送 skill 给用户确认（confidence）：
- "high"：用户明确表达了对这个 skill 的需求（如："帮我制定运动计划"、"分析一下我的血检报告"），可以主动介绍 skill 并询问是否使用
- "low"：用户只是问了健康问题，但没有明确要求使用某项服务/技能（如："我最近血糖有点高"），应该直接 AI 回复，不要主动推销 skill

只返回 JSON，不要有其他任何内容：{"skill_id": "xxx" 或 null, "skill_name": "xxx" 或 null, "confidence": "high" 或 "low", "reason": "一句话理由"}`;

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
    const confidence: 'high' | 'low' = parsed.confidence === 'high' ? 'high' : 'low';
    if (skillId && !availableSkills.find(s => s.id === skillId)) {
      console.warn(`[AgentService] skill route returned unknown id=${skillId}, falling back to null`);
      return { skillId: null, skillName: null, reason: '路由返回了未知 skill，降级直接回复', confidence: 'low' };
    }
    console.log(`[AgentService] Skill route → id=${skillId} name=${skillName} confidence=${confidence} reason=${parsed.reason}`);
    return { skillId, skillName, reason: parsed.reason || '', confidence };
  } catch (err) {
    console.warn('[AgentService] Skill route failed, no skill selected:', err);
    return { skillId: null, skillName: null, reason: '路由失败，降级直接回复', confidence: 'low' };
  }
}

// ─── v2 架构：Step3 — 统一路由决策（替代 routeMessage + routeSkill）──────────

export interface RouteDecisionResult {
  skill_id:   string | null;
  skill_name: string | null;
  skill_desc: string | null;
  confidence: 'high' | 'low' | 'none'; // high=需要推荐skill | low=健康问题直接回答 | none=普通聊天
  reason:     string;
  durationMs: number;
  model:      string;
  rawResult:  string;
}

/**
 * 合并路由：一次 AI 调用同时完成"是否需要skill"和"哪个skill"的判断。
 * 替代旧的 routeMessage() + routeSkill() 两次调用。
 *
 * 输出：
 *   confidence=none  → 普通聊天，agent 直接回复
 *   confidence=low   → 健康问题但无明确 skill 意图，agent 直接回复（带健康知识）
 *   confidence=high  → 用户明确要用某个 skill，进入守卫流程
 */
async function routeDecision(
  content: string,
  history: { role: string; content: string }[],
  notes: string,
  availableSkills: { id: string; name: string; description: string }[],
  apiKey: string,
): Promise<RouteDecisionResult> {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  // 无可用 skill 时降级
  if (!availableSkills.length) {
    return { skill_id: null, skill_name: null, skill_desc: null, confidence: 'low',
             reason: '无可用skill，直接AI回复', durationMs: 0, model, rawResult: '' };
  }

  const skillList = availableSkills
    .map((s, i) => `${i + 1}. ID="${s.id}" 名称="${s.name}" 描述="${s.description.slice(0, 100)}"`)
    .join('\n');

  const recentHistory = history.slice(-20)
    .map(h => `${h.role === 'user' ? '客户' : '助手'}：${h.content}`)
    .join('\n');

  const systemPrompt = `你是智能路由助手。根据客户消息和对话历史，做出以下判断：

1. 客户的消息是否需要调用某个专项服务（skill）？如需要，选出最匹配的 skill。
2. 判断置信度（confidence）：
   - "high"：客户明确表达了要使用某个服务（如"帮我做营养分析""开始AI营养师"），可以主动向用户推荐该服务
   - "low"：客户有健康相关问题，但没明确要求使用某个服务（如"我血糖高怎么办"），直接用AI知识回答即可，不推销服务
   - "none"：普通聊天/问候/询问服务范围，直接回答，不涉及健康或服务

注意：
- 如果消息较短（补充说明、纠正）请结合近期对话历史判断真实意图
- "能咨询血糖问题吗""你们能做什么"等询问服务能力属于 none，不是 low
- 如没有合适的 skill，skill_id 返回 null

可用专项服务列表：
${skillList}

只返回 JSON，不要有其他内容：
{"skill_id": "xxx或null", "skill_name": "xxx或null", "confidence": "high或low或none", "reason": "一句话理由"}`;

  const userMsg = `客户备注：${notes || '（无）'}\n${recentHistory ? `近期对话：\n${recentHistory}\n` : ''}客户最新消息：${content}`;

  const t0 = Date.now();
  try {
    const result = await callGeminiMessages(systemPrompt, [{ role: 'user', content: userMsg }], apiKey, 512);
    const durationMs = Date.now() - t0;

    const jsonStart = result.indexOf('{');
    const jsonEnd   = result.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) throw new Error('no JSON in response');
    const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1));

    const skill_id   = parsed.skill_id   || null;
    const skill_name = parsed.skill_name || null;
    const confidence = (['high','low','none'] as const).includes(parsed.confidence)
      ? parsed.confidence as 'high'|'low'|'none' : 'none';

    // 验证 skill_id 真实存在
    const validSkill = skill_id ? availableSkills.find(s => s.id === skill_id) : null;
    const finalSkillId   = validSkill ? skill_id   : null;
    const finalSkillName = validSkill ? skill_name : null;
    const finalSkillDesc = validSkill ? validSkill.description : null;

    if (skill_id && !validSkill) {
      console.warn(`[RouteDecision] 路由返回了未知 skill_id=${skill_id}，降级 null`);
    }

    console.log(`[RouteDecision] skill=${finalSkillName || 'none'} confidence=${confidence} reason=${parsed.reason} (${durationMs}ms)`);
    return { skill_id: finalSkillId, skill_name: finalSkillName, skill_desc: finalSkillDesc,
             confidence, reason: parsed.reason || '', durationMs, model, rawResult: result.trim() };

  } catch (err) {
    const durationMs = Date.now() - t0;
    console.warn('[RouteDecision] 路由失败，降级 confidence=none:', err);
    return { skill_id: null, skill_name: null, skill_desc: null, confidence: 'none',
             reason: '路由失败，降级直接回复', durationMs, model, rawResult: '(error)' };
  }
}

// ─── v2 架构：Step5 — Agent 上下文包 + directive 生成 ─────────────────────────

export type GuardStatus = 'new_created' | 'confirmed_ticket' | 'declined' | 'pending_unclear' | 'none';

export interface AgentContextPackage {
  userMessage:     string;
  history:         { role: string; content: string }[];
  notes:           string;
  // 路由结果
  routeSkillId:    string | null;
  routeSkillName:  string | null;
  routeSkillDesc:  string | null;
  routeConfidence: 'high' | 'low' | 'none';
  // 守卫结果
  guardStatus:     GuardStatus;
  guardSkillName:  string | null;
  ticketUrl:       string | null;
  // 工单状态（来自 ctxSnapshot.recentTicket）
  existingTicket: {
    skillId:       string;
    skillName:     string;
    status:        string;
    createdAt:     number;
    reportContent: string | null;
    reportUrl:     string | null;
    h5Url:         string | null;
  } | null;
  // 代码生成的 directive
  directive: string;
}

/**
 * 根据路由结果 + 守卫状态 + 工单状态组装 Agent 上下文包。
 * directive 由代码 if-else 生成，不依赖 AI。
 */
function assembleAgentContext(params: {
  req:            any;
  routeSkillId:   string | null;
  routeSkillName: string | null;
  routeSkillDesc: string | null;
  routeConf:      'high' | 'low' | 'none';
  guardStatus:    GuardStatus;
  guardSkillName: string | null;
  ticketUrl:      string | null;
  recentTicket:   any | null;
  serviceUrl:     string;
}): AgentContextPackage {
  const { req, routeSkillId, routeSkillName, routeSkillDesc, routeConf,
          guardStatus, guardSkillName, ticketUrl, recentTicket, serviceUrl } = params;

  // 组装 existingTicket
  let existingTicket: AgentContextPackage['existingTicket'] = null;
  if (recentTicket) {
    const h5Url = recentTicket.status === 'waiting_input' && recentTicket.h5_token
      ? `${serviceUrl}/h5?token=${recentTicket.h5_token}`
      : null;
    existingTicket = {
      skillId:       recentTicket.skill_id || '',
      skillName:     recentTicket.skill_name || recentTicket.skill_id || '未知服务',
      status:        recentTicket.status || 'unknown',
      createdAt:     Number(recentTicket.created_at || 0),
      reportContent: recentTicket.raw_result || null,
      reportUrl:     recentTicket.report_url || null,
      h5Url,
    };
  }

  // ── directive 生成（代码 if-else，不依赖 AI）─────────────────────────────────
  let directive = '';

  if (guardStatus === 'new_created' && routeSkillName) {
    directive = `用户表达了对「${routeSkillName}」服务的意向，守卫已创建。`
      + `请向用户介绍该服务，并自然地询问是否确认使用。`
      + (routeSkillDesc ? `\n服务描述：${routeSkillDesc.slice(0, 200)}` : '');

  } else if (guardStatus === 'confirmed_ticket' && ticketUrl) {
    directive = `用户已确认使用「${guardSkillName || routeSkillName || ''}」，工单已建立。`
      + `\n工单链接：${ticketUrl}`
      + `\n请告知用户工单已创建，引导他点击链接填写问卷。直接使用以上链接，不要自己生成链接。`;

  } else if (guardStatus === 'declined') {
    directive = `用户明确拒绝了「${guardSkillName || ''}」服务，守卫已关闭。请正常回答用户的问题。`;

  } else if (guardStatus === 'pending_unclear' && guardSkillName) {
    if (routeSkillId && routeSkillId !== (params.recentTicket?.skill_id) && routeSkillName !== guardSkillName) {
      // 不同 skill
      directive = `用户对「${guardSkillName}」服务有意向但尚未确认。`
        + `本次消息话题指向「${routeSkillName}」，无需重复推荐守卫中的服务。`
        + `请先回答用户的问题。`;
    } else {
      // 同 skill 或无路由 skill
      directive = `用户对「${guardSkillName}」服务有意向但尚未确认。`
        + `请先回答用户的问题，如果对话场景合适，在回答末尾自然地引导用户确认是否使用该服务（不要强迫，感觉自然即可）。`;
    }

  } else if (guardStatus === 'none' && existingTicket) {
    if (existingTicket.status === 'processing' || existingTicket.status === 'submitted') {
      directive = `用户有一个进行中的「${existingTicket.skillName}」工单（状态：处理中）。`
        + `如果用户在询问进度，告知「正在分析，完成后会通知您」。`;
    } else if (existingTicket.status === 'done' && existingTicket.reportContent) {
      directive = `用户有一份已完成的「${existingTicket.skillName}」分析报告（报告内容见下方）。`
        + `如用户询问报告细节，请结合报告内容具体回答。`;
    } else if (existingTicket.status === 'done') {
      directive = `用户有一份已完成的「${existingTicket.skillName}」分析报告。`
        + (existingTicket.reportUrl ? `\n报告链接：${existingTicket.reportUrl}` : '');
    } else if (existingTicket.status === 'waiting_input' && existingTicket.h5Url) {
      directive = `用户有一个未填写的「${existingTicket.skillName}」工单。`
        + `\n请提示用户点击以下链接完成填写：${existingTicket.h5Url}`;
    }
  }
  // guardStatus=none + 无工单 → directive 为空，Agent 正常回答

  return {
    userMessage:     req.content,
    history:         req.history || [],
    notes:           req.notes || '',
    routeSkillId,
    routeSkillName,
    routeSkillDesc,
    routeConfidence: routeConf,
    guardStatus,
    guardSkillName:  guardSkillName || null,
    ticketUrl,
    existingTicket,
    directive,
  };
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
- 如客户涉及具体健康问题，结合健康档案直接给出简洁的专业建议
- 绝对不要说"正在分析"、"请稍等"、"马上回复"等让用户等待的话，你必须直接回答
- 绝对不要自己生成任何链接（URL），尤其不要生成 h5?token= 类的工单链接。如果客户想使用分析服务，告知"好的，为您安排"即可，系统会自动处理`;

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

  // Step 7 (v2): 读取 directive（由 assembleAgentContext 代码生成，非AI）
  const directive = (req as any)._directive as string | undefined;
  const directiveBlock = directive
    ? `\n\n【本轮指令（优先遵循）】\n${directive}`
    : '';

  const systemPrompt = `你是${profile.name}，${profile.role_desc || '专业的健康顾问'}，根据客户的健康档案和问题提供专业且个性化的建议。
回复风格：${profile.reply_style || '亲切专业，回复控制在300字以内'}${tabooText}${profileBlock}${healthBlock}${directiveBlock}

要求：
- 不要使用 Markdown 格式
- 亲切专业，直接称呼客户为"${fromName}"
- 如无健康档案，基于对话内容给出通用建议
- 如有【本轮指令】，优先遵循指令中的行为要求，再正常回答问题`;


  const contextBlock = [
    notes ? `【客户备注】\n${notes}` : '',
    `【当前问题】\n${content}`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: contextBlock },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 2048, {
    tools: WIKI_TOOLS,  // Step 6: 始终传入，包含 query_ticket
    userId: meta.user_id,
    onToolCall: (name, args, result) => {
      // Step 6: 记录 tool call 事件到日志
      if (name === 'query_ticket') {
        void appendTaskEvent(requestId, 'tool_query_ticket', {
          userId: meta.user_id,
          result: (() => { try { return JSON.parse(result); } catch { return result; } })(),
        });
        console.log(`[AgentService] 🔧 tool_query_ticket 已触发 userId=${meta.user_id}`);
      }
    },
  });


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

  // ── 检查 skill 类型：external → 工单流程，internal → 直接 sandbox ──────────
  const skillRow = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [skillId]);
  const isExternal = skillRow?.type === 'external';

  if (isExternal) {
    // ── 防抖：8秒内同一 user+skill 只允许一次工单创建 ──────────────────────
    const lockKey = `${meta.user_id || 'anon'}:${skillId}`;
    if (_ticketCreationLocks.has(lockKey)) {
      console.log(`[AgentService] 🔒 工单防抖拦截 lockKey=${lockKey}`);
      void updateAgentTask(requestId, { status: 'done', routeType: 'ticket_debounced', endedAt: Date.now() });
      return {
        request_id: requestId, status: 'done',
        reply: `${fromName}，您的请求正在处理中，请稍候～`,
        delivery, route_type: 'ticket_debounced',
      } as any;
    }
    _ticketCreationLocks.add(lockKey);
    setTimeout(() => _ticketCreationLocks.delete(lockKey), 8000);

    // ── 1小时内：查是否有相同 user+skill 的活跃工单 ──────────────────────────
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const h5BaseRow = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', ['h5_base_url']);
    const h5Base = h5BaseRow?.value || `${serviceUrl}/h5`;

    if (meta.user_id) {
      const existing = await db.getAsync<any>(
        `SELECT * FROM tickets WHERE created_by=? AND skill_id=? AND created_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        [meta.user_id, skillId, oneHourAgo]
      );

      if (existing && existing.status !== 'error') {
        const exUrl     = `${h5Base}?token=${existing.token}`;
        const baseUrl   = h5Base.replace(/\/h5$/, '');
        const reportUrl = `${baseUrl}/api/results/${existing.id}/report`;
        let reply = '';

        if (existing.status === 'waiting_input') {
          reply = `${fromName}，您已有一个等待填写的「${skillName}」工单，请点击链接填写：\n\n${exUrl}`;
        } else if (existing.status === 'submitted' || existing.status === 'processing') {
          reply = `${fromName}，您的「${skillName}」分析正在处理中，请稍候，完成后将通知您 ⏳`;
        } else if (existing.status === 'done') {
          reply = `${fromName}，您的「${skillName}」分析报告已生成 🎉\n\n点击查看报告：\n${reportUrl}`;
        } else if (existing.status === 'returned') {
          const reason = existing.return_reason ? `\n原因：${existing.return_reason}\n\n` : '\n\n';
          reply = `${fromName}，工作人员已审阅并打回您的「${skillName}」工单，请重新填写：${reason}${exUrl}`;
        }

        if (reply) {
          void appendTaskEvent(requestId, 'ticket_reused', { ticketId: existing.id, status: existing.status });
          const endMs = Date.now();
          void updateAgentTask(requestId, {
            status: 'done', routeType: 'ticket_reused', skillId,
            replyContent: reply, endedAt: endMs,
            durationMs: endMs - ((req as any)._taskStartMs || endMs),
          });
          return { request_id: requestId, status: 'done', reply, delivery, route_type: 'ticket_reused' } as any;
        }
        // status='error' → 不复用，继续新建
      }
    }

    // ── 新建工单 ──────────────────────────────────────────────────────────────
    console.log(`[AgentService] 📋 External skill「${skillName}」→ 创建工单`);

    const patientName = meta.from_name || null;
    const prefilledNotes = [
      notes ? `【备注】${notes}` : '',
      wikiCtx?.user_profile ? `【用户画像】${wikiCtx.user_profile.slice(0, 300)}` : '',
      content ? `【用户问题】${content}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 800) || null;

    const ticketId = require('crypto').randomUUID();
    const token    = require('crypto').randomUUID().replace(/-/g, '');
    const now      = Date.now();
    const expiresAt = now + 60 * 60 * 1000; // 1小时有效（与复用窗口一致）

    const deliveryInfo = JSON.stringify({
      callback_url: req.callback_url || '',
      app:          delivery.app,
      recipient:    delivery.recipient,
      action:       delivery.action,
    });

    await db.runAsync(
      `INSERT INTO tickets
        (id, skill_id, token, title, patient_name, notes,
         created_by, status, return_count, expires_at, created_at, updated_at, delivery_info, request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticketId, skillId, token,
       `${skillName} — ${fromName} — ${new Date(now).toLocaleDateString('zh-CN')}`,
       patientName, prefilledNotes,
       meta.user_id || null, 'waiting_input', 0, expiresAt, now, now, deliveryInfo, requestId],
    );

    const ticketUrl  = `${h5Base}?token=${token}`;
    const replyToUser = `${fromName}，已为您创建「${skillName}」分析工单 🎉\n\n我们已根据您的健康档案预填了部分信息，请点击以下链接确认并补充，提交后 AI 将为您生成专属分析报告：\n\n${ticketUrl}`;

    void appendTaskEvent(requestId, 'ticket_created', {
      ticketId, skillId, skillName,
      token: token.slice(0, 8) + '...',
      ticketUrl,
      prefilledNotes: prefilledNotes?.slice(0, 200) || '',
    });
    void appendTaskEvent(requestId, 'reply_sent', {
      replyLen: replyToUser.length, reply: replyToUser.slice(0, 300),
      channel: delivery.app, recipient: delivery.recipient, note: 'ticket_link',
    });
    const endMs = Date.now();
    void updateAgentTask(requestId, {
      status: 'done', routeType: 'ticket_created', skillId,
      replyContent: replyToUser, endedAt: endMs,
      durationMs: endMs - ((req as any)._taskStartMs || endMs),
    });

    return {
      request_id: requestId, status: 'done',
      reply:      replyToUser, delivery,
      reasoning:  `External skill「${skillName}」→ 工单已创建，等待用户填写提交`,
      route_type: 'ticket_created',
    } as any;
  }

  // ── Internal Skill：直接提交 sandbox（原有流程）────────────────────────────
  pendingRequests.set(requestId, {
    callbackUrl:  req.callback_url || '',
    sessionId:    session_id,
    delivery,
    userId:       meta.user_id || '',
    userContent:  content,
    skillName:    skillName || '',
    fromName:     meta.from_name || '',
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

  void appendTaskEvent(requestId, 'skill_input', {
    message_preview: sandboxUserMessage,
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

  const sandboxServiceUrl = process.env.SANDBOX_SERVICE_URL || '';
  const effectiveModel = skillRow?.preferred_model || 'gemini-3.6-flash';
  const isApproved = skillRow?.status === 'approved' || skillRow?.status === 'published';

  try {
    if (isApproved && sandboxServiceUrl) {
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
      console.log(`[AgentService] Cloud Run Job submitted: skill=${skillName}(${skillId}), requestId=${requestId}`);
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

  const { callbackUrl, sessionId, delivery, userId, userContent, skillName: pendingSkillName, fromName: pendingFromName } = pending;
  const agentOutput: string = (jobResult?.output || '（Agent 未返回内容）').trim();

  // ── Task 5: 生成结果查看链接日志 ──
  const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || '';
  const resultViewUrl = PUBLIC_BASE ? `${PUBLIC_BASE}/skill-result/${requestId}` : '';
  const replyToUser = resultViewUrl
    ? `${pendingFromName || '您'}好，您的${pendingSkillName ? `「${pendingSkillName}」` : ''}分析已完成 🎉\n\n请点击查看完整结果（可在页面确认是否将建议纳入健康档案）：\n${resultViewUrl}`
    : agentOutput.slice(0, 200) + (agentOutput.length > 200 ? '\n\n（如需查看完整报告，请联系顾问）' : '');

  console.log(`[AgentService] 🔗 结果链接: requestId=${requestId} mode=${resultViewUrl ? '链接' : '摄要降级'} url=${resultViewUrl || '(没有PUBLIC_BASE_URL，发摘要)'} outputLen=${agentOutput.length}`);
  void appendTaskEvent(requestId, 'result_link_built', {
    hasPublicBase:  !!PUBLIC_BASE,
    resultViewUrl:  resultViewUrl || '',
    mode:           resultViewUrl ? '链接模式' : '摘要降级模式',
    outputLen:      agentOutput.length,
    replyLen:       replyToUser.length,
    replyPreview:   replyToUser.slice(0, 100),
  });

  const callbackBody = {
    request_id: requestId,
    session_id: sessionId,
    status:     'done',
    reply:      replyToUser,  // Task 5: 发链接而非全文
    delivery,
    reasoning:  '健康 Skill 执行完成',
  };

  console.log(`[AgentService] Job done for ${requestId}, output length=${agentOutput.length}`);

  // ── 记录事件 ──
  const transcriptJson = jobResult?.transcript ? JSON.stringify(jobResult.transcript) : null;
  void appendTaskEvent(requestId, 'skill_done', {
    outputLen: agentOutput.length,
    output_preview: agentOutput.slice(0, 400),
  });
  void appendTaskEvent(requestId, 'reply_sent', {
    reply:           replyToUser.slice(0, 600),
    replyLen:        replyToUser.length,
    channel:         delivery.app,
    recipient:       delivery.recipient,
    delivery_action: delivery.action,
    cua_url:         process.env.CUA_SEND_URL || '',
    mode:            resultViewUrl ? '链接模式' : '摘要降级',
    result_url:      resultViewUrl || '(无)',
  });

  // ── Task 6: Skill 完成后不立即 wiki sync，等用户点确认 ──
  console.log(`[AgentService] ⏸️ wiki sync 暂求（等用户在结果页点「认可并执行」）: userId=${userId} requestId=${requestId}`);
  void appendTaskEvent(requestId, 'wiki_sync_pending', {
    reason: 'Skill 完成，暂不写入 wiki，等待用户在结果页点「认可并执行」',
    result_url: resultViewUrl || '',
    userId,
  });
  backgroundPostLog(userId, userContent, agentOutput);
  void updateAgentTask(requestId, {
    status: 'done',
    replyContent: agentOutput,
    endedAt: Date.now(),
    ...(transcriptJson ? { jobTranscript: transcriptJson } : {}),
  });
  syncCounters.set(userId, 0);

  if (!callbackUrl) {
    // /orch/ingest 路径没有 callbackUrl，用 CUA_SEND_URL 直接发送
    const cuaSendUrl = process.env.CUA_SEND_URL;
    if (cuaSendUrl) {
      console.log(`[AgentService] No callback_url, sending via CUA_SEND_URL for ${requestId}`);
      fetch(`${cuaSendUrl}/api/agent-callback`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Secret': process.env.AGENT_SECRET || '' },
        body:    JSON.stringify(callbackBody),
        signal:  AbortSignal.timeout(30_000),
      }).then(r => console.log(`[AgentService] CUA final reply HTTP ${r.status}`))
        .catch(e => console.warn(`[AgentService] CUA final reply failed:`, e.message));
    } else {
      console.log(`[AgentService] No callback_url and no CUA_SEND_URL for ${requestId}`);
    }
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

  // ── 立即触发 CUA 预热（并行于后续处理，不阻塞）─────────────────────────
  const cuaSendUrl = process.env.CUA_SEND_URL || '';
  if (cuaSendUrl && req.meta?.from_name) {
    // fire-and-forget: 通知 Mac mini 提前把企业微信置于前台
    fetch(`${cuaSendUrl}/api/prewarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: '企业微信',
        session_id: userId || req.session_id,
        request_id: requestId,
      }),
      signal: AbortSignal.timeout(15_000),
    }).then(async r => {
      const data = await r.json().catch(() => ({})) as any;
      console.log(`[Prewarm] HTTP ${r.status} ready=${data.ready} pid=${data.pid} status=${data.status}`);
      // 非 200 或 skipped/error/undefined → 统一当作 "跳过"（预热是 best-effort，失败不是错误）
      if (!r.ok || data.status === 'skipped' || data.status === 'error' || data.ready === undefined) {
        void appendTaskEvent(requestId, 'app_prewarm', {
          ready: null,
          skipped: true,
          app: '企业微信',
          error: data.error || (r.ok ? '' : `HTTP ${r.status}`),
        });
      } else {
        void appendTaskEvent(requestId, 'app_prewarm', {
          ready: data.ready ?? false,
          pid: data.pid,
          app: data.app || '企业微信',
          error: data.error || '',
        });
      }
    }).catch(e => {
      console.warn(`[Prewarm] ⚠️ 预热跳过: ${e.message}`);
      void appendTaskEvent(requestId, 'app_prewarm', {
        ready: null,
        skipped: true,
        error: e.message,
        app: '企业微信',
      });
    });
  }

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
    } else {
      // Profile 有实质内容，但仍清除其中的空白小节（## 标题 + 注释 + 暂无记录）
      const cleanedProfile = wikiCtx.user_profile
        .replace(/##\s+[^\n]*\n<!--[^>]*-->\n暂无记录。?\n?/g, '')  // ## 标题 + 注释 + 暂无记录
        .replace(/\n{3,}/g, '\n\n')  // 合并多余空行
        .trim();
      if (cleanedProfile !== wikiCtx.user_profile) {
        wikiCtx = { ...wikiCtx, user_profile: cleanedProfile };
        console.log(`[AgentService] Profile 清除空白小节: ${wikiCtx.user_profile.length}字 → ${cleanedProfile.length}字`);
      }
    }

    // ── 清理 wiki 中的空模板内容 ──────────────────────────────────────────────
    if (wikiCtx.health_wiki) {
      let cleanedWiki = wikiCtx.health_wiki
        // 去掉只有「暂无记录」的表格行（如 | 用药 | 暂无记录 | – | – | – |）
        .replace(/\|[^|]*\|\s*暂无记录\s*\|[\s\-|]*\n?/g, '')
        // 去掉空表格（只剩表头+分隔线，没有数据行）
        .replace(/(\|[^\n]+\|\n\|[-|\s]+\|\n)(?=\n|$)/g, '')
        // 去掉空的 code block 模板（```xxx-block\n...\ncontent: ""\n```）
        .replace(/```[\w-]+-block\n[\s\S]*?content:\s*""\n```\n?/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleanedWiki.length < wikiCtx.health_wiki.length) {
        console.log(`[AgentService] Wiki 清除空模板: ${wikiCtx.health_wiki.length}字 → ${cleanedWiki.length}字`);
        wikiCtx = { ...wikiCtx, health_wiki: cleanedWiki };
      }
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

  // ── Step 0.8 (v2): 路由前上下文预查询 ─────────────────────────────────────
  // 一次性查好守卫状态 + 工单状态，后续所有步骤直接用，不重复查DB
  const ctxSnapshot = await queryContextSnapshot(sessionId || null, userId || null);
  void appendTaskEvent(requestId, 'context_snapshot', {
    hasGuard:    !!ctxSnapshot.activeGuard,
    guardSkill:  ctxSnapshot.activeGuard?.skill_name || null,
    guardId:     ctxSnapshot.activeGuard?.id || null,
    guardRounds: ctxSnapshot.activeGuard?.check_count || 0,
    hasTicket:   !!ctxSnapshot.recentTicket,
    ticketSkill: ctxSnapshot.recentTicket?.skill_id || null,
    ticketStatus:ctxSnapshot.recentTicket?.status || null,
    ticketAge:   ctxSnapshot.recentTicket ? Math.round((Date.now() - Number(ctxSnapshot.recentTicket.created_at)) / 60000) + 'min' : null,
  });
  console.log(`[AgentService] 📸 context_snapshot: guard=${ctxSnapshot.activeGuard?.skill_name||'none'} ticket=${ctxSnapshot.recentTicket?.status||'none'}`);

  // ── Step 0.9: Skill 确认守卫前置检查 ─────────────────────────────────────────
  // 在 routeMessage 之前检查：当前 session 是否有激活的 skill_suggest 守卫？
  // 如果有，运行三值判断（感兴趣/确认），跳过或改写后续路由
  let guardHint = '';  // 往后传递的提示词（如「用户对推荐 skill 不感兴趣」）
  let currentGuardStatus: GuardStatus = 'none';          // Step 5 (v2): 追踪守卫状态
  let currentGuardSkillName: string | null = null;       // Step 5 (v2): 守卫对应的 skill
  if (sessionId) {

    const nowMs = Date.now();
    const activeGuard = await db.getAsync<any>(
      `SELECT * FROM skill_confirm_guards
       WHERE session_id=? AND status='active' AND expires_at>?
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, nowMs],
    );
    if (activeGuard) {
      const MAX_GUARD_ROUNDS = 10;  // 超过 10 轮未确认则自动关闭守卫

      // 每次检查都递增 check_count
      const newCheckCount = (activeGuard.check_count || 0) + 1;
      await db.runAsync(
        `UPDATE skill_confirm_guards SET check_count=? WHERE id=?`,
        [newCheckCount, activeGuard.id],
      );

      console.log(`[SkillGuard] 🔍 发现活跃守卫 id=${activeGuard.id} skill=${activeGuard.skill_name} round=${newCheckCount}/${MAX_GUARD_ROUNDS}`);
      void appendTaskEvent(requestId, 'skill_guard_check', {
        guardId: activeGuard.id,
        skillId: activeGuard.skill_id,
        skillName: activeGuard.skill_name,
        suggestTs: activeGuard.suggest_ts,
        checkCount: newCheckCount,
        maxRounds: MAX_GUARD_ROUNDS,
        userMsg: req.content.slice(0, 200),
      });
      // ── Step 4 (v2): guard_lifecycle=existing 事件 ─────────────────────────
      void appendTaskEvent(requestId, 'guard_lifecycle', {
        action: 'existing',
        guardId: activeGuard.id,
        skillId: activeGuard.skill_id,
        skillName: activeGuard.skill_name,
        round: newCheckCount,
      });
      // 超过轮数限制→自动关闭，往下游传 hint
      if (newCheckCount > MAX_GUARD_ROUNDS) {
        await db.runAsync(
          `UPDATE skill_confirm_guards SET status='closed', close_reason='round_limit' WHERE id=?`,
          [activeGuard.id],
        );
        console.log(`[SkillGuard] ⏱️ 超过 ${MAX_GUARD_ROUNDS} 轮限制，守卫已关闭`);
        void appendTaskEvent(requestId, 'skill_guard_closed', {
          guardId: activeGuard.id,
          skillName: activeGuard.skill_name,
          reason: 'round_limit',
          checkCount: newCheckCount,
        });
        guardHint = `[守卫提示：用户连续${MAX_GUARD_ROUNDS}轮没有确认「${activeGuard.skill_name}」服务，守卫已自动关闭，请正常回答]`;
      } else {
      // 截取 suggest_ts 之后的对话（让 AI 看到完整上下文，而非只看最后一条）
      const historyAfterSuggest = (req.history || [])
        .filter((h: any) => !h.ts || h.ts >= activeGuard.suggest_ts)
        .map((h: any) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`)
        .join('\n');

      // 守卫 AI 判断：用 callGeminiMessages，明确禁止推理过程，max_tokens 足够大确保 JSON 不被截断
      const guardSystemPrompt = `你是一个 JSON 状态判断器。禁止输出推理过程或解释，只输出一个 JSON 对象，不包含任何其他文字。

背景：AI助手之前向用户推荐了「${activeGuard.skill_name}」服务。

对话记录：
${historyAfterSuggest || '（推荐后暂无其他对话）'}

用户最新消息：「${req.content}」

请判断：
- interest: "yes"（未明确拒绝）或 "no"（明确说不用/算了）
- confirm: "yes"（有启动意图：「帮我分析/做/开始」「开始吧」「确认」「我要用」，或「好的/行/可以+动词」）
  或 "no"（明确拒绝），或 "unclear"（仅单独「好的」「嗯」等无动词，或在提问）

输出示例：
- 用户说「帮我开始分析吧」→ {"interest": "yes", "confirm": "yes"}
- 用户说「好的，帮我做」→ {"interest": "yes", "confirm": "yes"}
- 用户说「好的」（单独）→ {"interest": "yes", "confirm": "unclear"}
- 用户说「这个多久出结果？」→ {"interest": "yes", "confirm": "unclear"}
- 用户说「不用了」→ {"interest": "no", "confirm": "no"}

只输出 JSON，不输出任何其他文字：`;

      const guardUserMsg = `根据以上对话，输出判断结果 JSON：`;

      let guardResult: { interest: 'yes'|'no'; confirm: 'yes'|'no'|'unclear' } = { interest: 'yes', confirm: 'unclear' };

      try {
        const t0 = Date.now();
        const raw = await callGeminiMessages(guardSystemPrompt, [{ role: 'user', content: guardUserMsg }], apiKey, 1024);
        const durationMs = Date.now() - t0;
        // 支持模型输出 {"interest":...} 或前缀文字 + {"interest":...}
        // 去除 markdown 代码块后提取 JSON（支持模型在 JSON 前后有额外文字）
        const cleanRaw = raw.replace(/```[a-z]*\n?/gi, '').trim();
        const jsonMatch = cleanRaw.match(/\{[\s\S]*\}/);
        let parsed: any = {};
        if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch { /* keep {} */ } }
        guardResult = {
          interest: parsed.interest === 'no' ? 'no' : 'yes',
          confirm:  ['yes','no','unclear'].includes(parsed.confirm) ? parsed.confirm : 'unclear',
        };
        console.log(`[SkillGuard] 🤔 interest=${guardResult.interest} confirm=${guardResult.confirm} (${durationMs}ms) raw="${raw.slice(0,100)}"`);
        void appendTaskEvent(requestId, 'skill_guard_judgment', {
          guardId: activeGuard.id,
          skillName: activeGuard.skill_name,
          interest: guardResult.interest,
          confirm: guardResult.confirm,
          durationMs,
          rawResult: raw.slice(0, 300),
        });
      } catch (e: any) {
        console.warn(`[SkillGuard] ⚠️ 判断失败，保持 unclear: ${e.message}`);
        void appendTaskEvent(requestId, 'skill_guard_judgment', {
          guardId: activeGuard.id,
          error: e.message,
          interest: 'yes',
          confirm: 'unclear',
        });
      }

      const closeGuard = async (reason: string) => {
        await db.runAsync(
          `UPDATE skill_confirm_guards SET status='closed', close_reason=? WHERE id=?`,
          [reason, activeGuard.id],
        );
        console.log(`[SkillGuard] 🔒 守卫已关闭 id=${activeGuard.id} reason=${reason}`);
        void appendTaskEvent(requestId, 'skill_guard_closed', {
          guardId: activeGuard.id,
          skillName: activeGuard.skill_name,
          reason,
        });
      };

      if (guardResult.interest === 'no') {
        // ─ 用户不感兴趣 → 关闭守卫，往下游传 hint，走正常路由 ─
        await closeGuard('user_declined');
        guardHint = `[守卫提示：用户之前对「${activeGuard.skill_name}」服务不感兴趣，本轮消息与此无关，请正常回答]`;
        currentGuardStatus    = 'declined';                 // Step 5
        currentGuardSkillName = activeGuard.skill_name;    // Step 5

      } else if (guardResult.confirm === 'yes') {
        // ─ 明确确认 → 关闭守卫，直接执行 skill（跳过 routeMessage）─
        await closeGuard('user_confirmed');
        console.log(`[SkillGuard] ✅ 用户确认，直接执行 skill ${activeGuard.skill_id}`);
        currentGuardStatus    = 'confirmed_ticket';         // Step 5（工单将在 handleHealthSkill 创建）
        currentGuardSkillName = activeGuard.skill_name;    // Step 5

        // 将 skill_id 注入 req，让后续代码当作「前端强制指定」处理
        (req as any).skill_id = activeGuard.skill_id;

      } else if (guardResult.confirm === 'unclear') {
        // ─ 模糊确认 → 检查是否已经追问过 ─
        // 如果用户在提问（消息较长/含问号），让正常路由回答，守卫继续等
        // 只有用户发了短暂模糊回复（如「好的」「嗯」）且本次 guard 还没追问过，才触发追问
        const isUserAsking = req.content.includes('？') || req.content.includes('?');

        // 查是否已对此 guard 追问过
        const prevClarifyCount = await db.getAsync<any>(
          `SELECT COUNT(*) as cnt FROM agent_task_events
           WHERE event_type='skill_guard_clarify'
             AND JSON_EXTRACT(payload,'$.guardId')=?`,
          [activeGuard.id],
        ).then((r: any) => r?.cnt || 0).catch(() => 0);

        if (isUserAsking || prevClarifyCount > 0) {
          // 用户在提问，或已追问过 → 走正常路由，守卫保持
          console.log(`[SkillGuard] ❓ unclear 但用户在提问或已追问过(${prevClarifyCount}次)，走正常路由`);
          void appendTaskEvent(requestId, 'skill_guard_judgment', {
            guardId: activeGuard.id,
            note: `unclear→正常路由 isUserAsking=${isUserAsking} prevClarify=${prevClarifyCount}`,
          });
          currentGuardStatus    = 'pending_unclear';          // Step 5
          currentGuardSkillName = activeGuard.skill_name;   // Step 5
          // guardHint 不设置，直接 fall through 到正常路由
        } else {
          // 用户发了短暂模糊词 且 尚未追问过 → 追问一次
          console.log(`[SkillGuard] ❓ 首次模糊确认，追问用户`);
          const clarifyMsg = `您是想现在开始「${activeGuard.skill_name}」分析吗？如果是，请直接告诉我「开始」或「好，帮我分析」～`;

          void appendTaskEvent(requestId, 'skill_guard_clarify', {
            guardId: activeGuard.id,
            skillName: activeGuard.skill_name,
            clarifyMsg,
          });
          void appendTaskEvent(requestId, 'reply_sent', {
            replyLen: clarifyMsg.length,
            reply: clarifyMsg,
            channel: delivery.app,
            recipient: delivery.recipient,
            note: 'guard_clarify',
          });
          const endMs = Date.now();
          void updateAgentTask(requestId, {
            status: 'done',
            routeType: 'skill_guard_clarify',
            replyContent: clarifyMsg,
            endedAt: endMs,
            durationMs: endMs - taskStartMs,
          });
          return {
            request_id: requestId,
            status:     'done',
            reply:      clarifyMsg,
            delivery,
            reasoning:  `SkillGuard: 用户首次模糊，追问确认`,
            route_type: 'skill_guard_clarify',
          } as any;
        }


      } else {
        // ─ confirm=no（明确不用）→ 关闭守卫，走正常路由 ─
        await closeGuard('user_declined_explicit');
        guardHint = `[守卫提示：用户明确不使用「${activeGuard.skill_name}」服务，请正常回答]`;
        currentGuardStatus    = 'declined';                  // Step 5
        currentGuardSkillName = activeGuard.skill_name;     // Step 5
      }
      }  // end: else(未超轮数)
    }
  }

  // ── Step 1 (v2): 加载 Agent Profile + 可用 skill（前置，供 routeDecision 使用）──
  void updateAgentTask(requestId, { status: 'routing' });
  const profile = await loadAgentProfile();
  console.log(`[AgentService] Profile: skill_mode=${profile.skill_mode} reassurance=${profile.reassurance_mode}`);
  const availableSkills = await getAvailableSkills(profile);
  console.log(`[AgentService] Available skills: ${availableSkills.map(s => s.name).join(', ') || '(none)'}`);

  // 检查是否前端/守卫强制指定了 skill_id（守卫确认 yes 时注入，优先级最高）
  const forcedSkillId: string | null = (req as any).skill_id || null;
  let forcedSkillName: string | null = null;
  if (forcedSkillId) {
    const found = availableSkills.find(s => s.id === forcedSkillId)
      || await db.getAsync<any>('SELECT id, name FROM skills WHERE id=?', [forcedSkillId]);
    forcedSkillName = (found as any)?.name || forcedSkillId;
    console.log(`[AgentService] skill_id forced by guard/caller: ${forcedSkillId}`);
  }

  // ── Step 2 (v2): 统一路由决策（单次 AI 调用，替代 routeMessage + routeSkill）──
  let selectedSkillId:   string | null = null;
  let selectedSkillName: string | null = null;
  let selectedSkillDesc: string | null = null;
  let routeConfidence: 'high' | 'low' | 'none' = 'none';
  let routeReason = '';

  if (forcedSkillId) {
    // 守卫已确认 / 前端强制 → 跳过路由，直接执行
    selectedSkillId   = forcedSkillId;
    selectedSkillName = forcedSkillName;
    selectedSkillDesc = availableSkills.find(s => s.id === forcedSkillId)?.description || null;
    routeConfidence   = 'high';
    routeReason       = `守卫确认/前端强制 skill_id=${forcedSkillId}`;
    void appendTaskEvent(requestId, 'route_decided', {
      confidence: 'high', skill_id: selectedSkillId, skill_name: selectedSkillName,
      reason: routeReason, forced: true, durationMs: 0, guardHint: guardHint || null,
    });
  } else {
    // 正常路由：单次 AI 调用（v2）
    const rdResult = await routeDecision(
      guardHint ? `${req.content}\n${guardHint}` : req.content,
      req.history || [],
      req.notes || '',
      availableSkills,
      apiKey,
    );
    selectedSkillId   = rdResult.skill_id;
    selectedSkillName = rdResult.skill_name;
    selectedSkillDesc = rdResult.skill_desc;
    routeConfidence   = rdResult.confidence;
    routeReason       = rdResult.reason;

    console.log(`[AgentService] → routeDecision: confidence=${rdResult.confidence} skill=${rdResult.skill_name || 'none'} (${rdResult.durationMs}ms)`);
    void appendTaskEvent(requestId, 'route_decided', {
      confidence: rdResult.confidence,
      skill_id:   rdResult.skill_id,
      skill_name: rdResult.skill_name,
      reason:     rdResult.reason,
      durationMs: rdResult.durationMs,
      model:      rdResult.model,
      rawResult:  rdResult.rawResult?.slice(0, 200),
      guardHint:  guardHint || null,
    });
  }

  // ── Step 3 (v2): confidence=none → 普通聊天，直接 Agent 回复 ─────────────────
  if (routeConfidence === 'none') {
    void updateAgentTask(requestId, { status: 'executing', routeType: 'chat' });
    const chatResult = await handleChatReply(req, apiKey, requestId, delivery, profile);

    // 抢占检查
    const newerTaskChat = await db.getAsync<any>(
      `SELECT id FROM agent_tasks WHERE session_id = ? AND id != ? AND started_at > ? ORDER BY started_at DESC LIMIT 1`,
      [req.session_id, requestId, taskStartMs]
    ).catch(() => null);

    if (newerTaskChat) {
      console.log(`[AgentService] ✂️ 抢占: requestId=${requestId} 被 ${newerTaskChat.id} 抢占`);
      void appendTaskEvent(requestId, 'reply_preempted', {
        reason: '有更新消息正在处理，跳过本次回复',
        newer_task_id: newerTaskChat.id,
        skipped_reply_preview: chatResult.reply?.slice(0, 60) || '',
      });
      void updateAgentTask(requestId, { status: 'done', routeType: 'chat', replyContent: '[已抢占，未发送]', endedAt: Date.now(), durationMs: Date.now() - taskStartMs });
      return { ...chatResult, reply: '' };
    }

    const endMs = Date.now();
    void updateAgentTask(requestId, { status: 'done', routeType: 'chat', replyContent: chatResult.reply?.slice(0, 500), endedAt: endMs, durationMs: endMs - taskStartMs });
    void appendTaskEvent(requestId, 'reply_sent', { replyLen: chatResult.reply?.length, reply: chatResult.reply?.slice(0, 600), channel: delivery.app, recipient: delivery.recipient });
    return chatResult;
  }

  // ── Step 4 (v2): confidence=high → skill_suggest 推荐流程（v2 暂保留模板，Step8改为Agent）
  if (routeConfidence === 'high' && selectedSkillId && selectedSkillName && !forcedSkillId) {
    console.log(`[AgentService] 💡 skill_suggest: skill=${selectedSkillName}(${selectedSkillId}) 高置信度，向用户介绍并询问确认`);
    currentGuardStatus    = 'new_created';   // Step 5: 标记守卫状态
    currentGuardSkillName = selectedSkillName;


    // ── Step 4 (v2): 跨skill守卫切换 ─────────────────────────────────────────
    // 若当前有活跃守卫且是【不同 skill】，先关闭旧守卫，再建新守卫
    if (ctxSnapshot.activeGuard && ctxSnapshot.activeGuard.skill_id !== selectedSkillId) {
      const oldGuard = ctxSnapshot.activeGuard;
      try {
        await db.runAsync(
          `UPDATE skill_confirm_guards SET status='closed', close_reason='closed_by_new_skill' WHERE id=?`,
          [oldGuard.id],
        );
        console.log(`[SkillGuard] 🔄 跨skill切换：关闭旧守卫 id=${oldGuard.id} skill=${oldGuard.skill_name}`);
        void appendTaskEvent(requestId, 'guard_lifecycle', {
          action: 'closed_by_new_skill',
          guardId: oldGuard.id,
          oldSkillId: oldGuard.skill_id,
          oldSkillName: oldGuard.skill_name,
          newSkillId: selectedSkillId,
          newSkillName: selectedSkillName,
        });
      } catch (e: any) {
        console.warn(`[SkillGuard] ⚠️ 关闭旧守卫失败: ${e.message}`);
      }
    }

    // 若当前已有相同 skill 的活跃守卫，不重复创建
    const existingSameGuard = ctxSnapshot.activeGuard && ctxSnapshot.activeGuard.skill_id === selectedSkillId
      ? ctxSnapshot.activeGuard : null;
    if (existingSameGuard) {
      console.log(`[SkillGuard] ♻️ 同skill守卫已存在 id=${existingSameGuard.id}，不重复创建`);
      void appendTaskEvent(requestId, 'guard_lifecycle', {
        action: 'existing',
        guardId: existingSameGuard.id,
        skillId: selectedSkillId,
        skillName: selectedSkillName,
        note: 'skill_suggest重入：同skill守卫已存在',
      });
    }


    const fromName = req.meta.from_name || '您';
    const skillDescText = selectedSkillDesc || '';
    const suggestMsg = `${fromName}，根据您的需求，我们有一项「${selectedSkillName}」服务可能适合您。\n\n${skillDescText ? `📋 ${skillDescText.slice(0, 100)}${skillDescText.length > 100 ? '…' : ''}\n\n` : ''}请问您需要使用这项服务吗？`;

    void appendTaskEvent(requestId, 'skill_suggest', {
      skillId: selectedSkillId, skillName: selectedSkillName, reason: routeReason, suggestMsg,
    });
    void appendTaskEvent(requestId, 'reply_sent', {
      replyLen: suggestMsg.length, reply: suggestMsg.slice(0, 300),
      channel: delivery.app, recipient: delivery.recipient, note: 'skill_suggest',
    });

    const nowTs = Date.now();
    void updateAgentTask(requestId, {
      status: 'done', routeType: 'skill_suggest', skillId: selectedSkillId,
      replyContent: suggestMsg.slice(0, 500), endedAt: nowTs, durationMs: nowTs - taskStartMs,
    });

    // 激活守卫
    const guardId = `guard_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    try {
      await db.runAsync(
        `INSERT INTO skill_confirm_guards
          (id, session_id, user_id, skill_id, skill_name, suggest_msg, suggest_ts, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [guardId, sessionId, userId, selectedSkillId, selectedSkillName,
         suggestMsg, nowTs, nowTs, nowTs + 30 * 60 * 1000],
      );
      console.log(`[SkillGuard] 🛡️ guard 已激活 id=${guardId} skill=${selectedSkillName} session=${sessionId}`);
      void appendTaskEvent(requestId, 'skill_guard_activated', {
        guardId, skillId: selectedSkillId, skillName: selectedSkillName,
        expiresAt: new Date(nowTs + 30 * 60 * 1000).toISOString(),
      });
      // ── Step 4 (v2): guard_lifecycle=new_created 标准事件 ─────────────────
      void appendTaskEvent(requestId, 'guard_lifecycle', {
        action:    'new_created',
        guardId,
        skillId:   selectedSkillId,
        skillName: selectedSkillName,
        expiresAt: new Date(nowTs + 30 * 60 * 1000).toISOString(),
      });
    } catch (e: any) {
      console.warn(`[SkillGuard] ⚠️ guard 创建失败: ${e.message}`);
    }

    return {
      request_id: requestId, status: 'done', reply: suggestMsg, delivery,
      reasoning:  `Skill「${selectedSkillName}」高置信度匹配，询问用户确认`,
      route_type: 'skill_suggest',
    } as any;
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

  // ── confidence=low 时不执行 skill，走 Gemini 直接回复 ──
  // 只有前端强制指定 skill_id 或 skill_suggest 确认后才执行
  if (routeConfidence === 'low' && selectedSkillId) {
    console.log(`[AgentService] 📊 confidence=low, 不自动执行 skill「${selectedSkillName}」, 走 Gemini 直接回复`);
    void appendTaskEvent(requestId, 'skill_skipped_low_confidence', {
      skippedSkillId:   selectedSkillId,
      skippedSkillName: selectedSkillName,
      reason:           routeReason,
      note:             'confidence=low → 走 handleHealthDirect 直接回复，不启动 sandbox skill',
    });
    selectedSkillId   = null;
    selectedSkillName = null;
  }
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
    // ── Step 5 (v2): 组装 Agent 上下文包 + directive（直接回复路径）──────────────
    // guardStatus 说明：
    //   none           = 无守卫，无工单
    //   pending_unclear= 守卫存在但用户未确认（保留守卫，继续追问）
    //   declined       = 用户拒绝了守卫，正常回答
    //   new_created    = 守卫被新建（但此路径是已跳过 skill_suggest 的 fallthrough，很少见）
    const agentCtxPkg = assembleAgentContext({
      req,
      routeSkillId:   selectedSkillId,
      routeSkillName: selectedSkillName,
      routeSkillDesc: selectedSkillDesc,
      routeConf:      routeConfidence,
      guardStatus:    currentGuardStatus,
      guardSkillName: currentGuardSkillName,
      ticketUrl:      null,                    // 无工单，直接回复路径
      recentTicket:   ctxSnapshot.recentTicket || null,
      serviceUrl,
    });

    void appendTaskEvent(requestId, 'agent_context_assembled', {
      guardStatus:   agentCtxPkg.guardStatus,
      routeSkill:    agentCtxPkg.routeSkillName,
      confidence:    agentCtxPkg.routeConfidence,
      hasTicket:     !!agentCtxPkg.existingTicket,
      ticketStatus:  agentCtxPkg.existingTicket?.status || null,
      directive:     agentCtxPkg.directive?.slice(0, 200) || '',
    });
    console.log(`[AgentService] 📦 agent_context_assembled: guardStatus=${agentCtxPkg.guardStatus} directive=${agentCtxPkg.directive?.slice(0,50)||'(none)'}`);

    // ── Step 7 (v2): 把 directive 注入 req，供 handleHealthDirect 的 system prompt 使用
    if (agentCtxPkg.directive) {
      (req as any)._directive = agentCtxPkg.directive;
      console.log(`[AgentService] 📋 directive注入 →「${agentCtxPkg.directive.slice(0, 60)}...」`);
    }

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
