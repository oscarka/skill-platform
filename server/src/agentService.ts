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

// ─── Agent Task Tracking ──────────────────────────────────────────────────────────
// 每次外部消息处理都在 agent_tasks 表中生成一条记录，实现日志集中化
// SSE real-time push via EventEmitter
export const taskEventBus = new EventEmitter();
taskEventBus.setMaxListeners(50); // allow many SSE connections

// ─── Fire-and-forget 写入队列 ─────────────────────────────────────────────
// 核心问题：每次 void appendTaskEvent/updateAgentTask 都 await db.runAsync(),
// 占用 pool 连接 1-3s（跨太平洋延迟）。并发写入会耗尽连接池，导致主流程的关键查询 timeout。
// 解决：串行队列，同一时间只用 1 个连接处理非关键写入。
const _writeQueue: Array<() => Promise<void>> = [];
let _writeQueueRunning = false;

function enqueueWrite(fn: () => Promise<void>) {
  _writeQueue.push(fn);
  if (!_writeQueueRunning) _drainWriteQueue();
}

async function _drainWriteQueue() {
  _writeQueueRunning = true;
  while (_writeQueue.length > 0) {
    const fn = _writeQueue.shift()!;
    try { await fn(); }
    catch (err: any) { console.warn('[AgentTask][Queue] write failed:', err.message); }
  }
  _writeQueueRunning = false;
}

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

export function updateAgentTask(id: string, fields: {
  status?: string; routeType?: string; skillId?: string;
  replyContent?: string; errorMessage?: string; endedAt?: number; durationMs?: number;
  jobTranscript?: string; contextSnapshot?: string; cuaEvents?: string;
}): void {
  enqueueWrite(async () => {
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
  });
}

export function appendTaskEvent(taskId: string, eventType: string, payload?: Record<string, any>): void {
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  // SSE 推送立即执行（不等 DB 写入），保证前端实时更新
  taskEventBus.emit(`task:${taskId}`, { id: eventId, event_type: eventType, payload, ts });
  // DB 写入排队
  enqueueWrite(async () => {
    await db.runAsync(
      `INSERT INTO agent_task_events (id, task_id, event_type, payload, ts) VALUES (?, ?, ?, ?, ?)`,
      [eventId, taskId, eventType, payload ? JSON.stringify(payload) : null, ts]
    );
  });
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

function triggerWikiSync(userId: string, reason: string, maxLogs: number = 15): void {
  if (!LLMWIKI_BASE || !userId) {
    console.log(`[WikiSync] 跳过：LLMWIKI_BASE=${LLMWIKI_BASE ? '✓' : '✗'} userId=${userId || '(empty)'}`);
    return;
  }
  const url = `${LLMWIKI_BASE}/api/clients/${userId}/sync`;
  console.log(`[WikiSync] POST ${url} reason=${reason} userId=${userId} maxLogs=${maxLogs}`);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, maxLogs }),
    signal: AbortSignal.timeout(600_000),  // 10min: 3-stage LLM pipeline can take 5-10min
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
// Wiki 上下文内存缓存（60s TTL）
// 用户 wiki 内容变化很慢，相邻消息命中缓存可避免 6s HTTP 延迟
interface WikiCacheEntry { result: { user_profile: string; health_wiki: string; mode: string }; expireAt: number; }
const _wikiCache = new Map<string, WikiCacheEntry>();
const WIKI_CACHE_TTL_MS = 60_000;

async function fetchWikiContext(userId: string, query: string, fromName?: string): Promise<{ user_profile: string; health_wiki: string; mode: string }> {
  if (!LLMWIKI_BASE || !userId) {
    return { user_profile: '', health_wiki: '', mode: 'none' };
  }

  // 缓存命中
  const cacheKey = userId;
  const cached = _wikiCache.get(cacheKey);
  if (cached && Date.now() < cached.expireAt) {
    console.log(`[WikiContext] cache hit userId=${userId} (${Math.round((cached.expireAt - Date.now())/1000)}s left)`);
    return cached.result;
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
    const wikiResult = { user_profile: data.user_profile || '', health_wiki: data.health_wiki || '', mode: data.mode || 'full' };
    _wikiCache.set(cacheKey, { result: wikiResult, expireAt: Date.now() + WIKI_CACHE_TTL_MS });
    return wikiResult;
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

let _profileCache: AgentProfile | null = null;
let _profileCacheExpire = 0;

async function loadAgentProfile(): Promise<AgentProfile> {
  if (_profileCache && Date.now() < _profileCacheExpire) return _profileCache;
  try {
    const row = await db.getAsync<any>(
      'SELECT * FROM agent_profiles WHERE id = ?',
      [DEFAULT_PROFILE_ID]
    );
    const profile: AgentProfile = row ? {
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
    } : defaultProfile();
    _profileCache = profile;
    _profileCacheExpire = Date.now() + 60_000;  // 60s cache
    return profile;
  } catch {
    return _profileCache || defaultProfile();
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

// AI 凭证环境变量优先映射（避免 DB 查询，防止连接池耗尽）
const _settingEnvMap: Record<string, string> = {
  'doubao_api_key':    process.env.DOUBAO_API_KEY    || '',
  'doubao_base_url':   process.env.DOUBAO_BASE_URL   || 'https://ark.cn-beijing.volces.com/api/v3',
  'deepseek_api_key':  process.env.DEEPSEEK_API_KEY  || '',
  'deepseek_base_url': process.env.DEEPSEEK_BASE_URL || '',
  'gemini_api_key':    process.env.GEMINI_API_KEY    || '',
};

// 凭证结果缓存（60s TTL），避免每次 AI 调用都查 DB
let _credCache: { apiKey: string; baseUrl: string; model: string; provider: string } | null = null;
let _credCacheExpire = 0;

async function getSetting(key: string): Promise<string> {
  // 凭证 key 永远从 env map 读，不查 DB（即使值为空）
  // 避免空 env var 导致 DB 查询洪水
  if (key in _settingEnvMap) return _settingEnvMap[key];
  // 其他 key 正常走 DB
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  return row?.value || '';
}


async function getGeminiKey(): Promise<string> {
  return (await getSetting('gemini_api_key')) || process.env.GEMINI_API_KEY || '';
}

async function getAICredentials(): Promise<{ apiKey: string; baseUrl: string; model: string; provider: string }> {
  // 60s 缓存，避免每次 AI 调用都触发多个 DB 查询（连接池耗尽的根本原因）
  if (_credCache && Date.now() < _credCacheExpire) return _credCache;

  // ARK (DeepSeek) 为默认，Gemini 为 fallback
  const [doubaoKey, doubaoBase, geminiKey] = await Promise.all([
    getSetting('doubao_api_key').then((k: string) => k || getSetting('deepseek_api_key')),
    getSetting('doubao_base_url').then((u: string) => u || getSetting('deepseek_base_url')),
    getGeminiKey(),
  ]);
  const result = doubaoKey && doubaoBase
    ? { apiKey: doubaoKey, baseUrl: doubaoBase.replace(/\/$/, ''), model: 'deepseek-v4-flash-ga-260731', provider: 'ark' }
    : { apiKey: geminiKey, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.6-flash', provider: 'gemini' };
  _credCache = result;
  _credCacheExpire = Date.now() + 60_000;
  console.log(`[AI] credentials resolved: provider=${result.provider} model=${result.model}`);
  return result;
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

// ─── AI multi-turn call (ARK/DeepSeek 默认，Gemini fallback) ────────────────────
// 保留 callGeminiMessages 名称硬兼容，内部动态选择 ARK 或 Gemini

async function callGeminiMessages(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  apiKey: string,
  maxTokens = 4096,
  options?: {
    tools?: any[];
    userId?: string;
    onToolCall?: (name: string, args: any, result: string) => void;
  },
): Promise<string> {
  // 动态获取凭证（忽略外部传入的 apiKey，统一走 settings DB）
  const creds = await getAICredentials();
  const BASE  = creds.baseUrl;
  const tools = options?.tools;
  const userId = options?.userId || '';

  // 构造初始消息列表
  const allMessages: any[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // 最多 4 轮 tool call
  for (let round = 0; round < 4; round++) {
    const reqBody: any = {
      model:      creds.model,
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
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`AI API error ${res.status} [${creds.provider}]: ${errText.slice(0, 200)}`);
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
    // 记录 AI thinking（DeepSeek/ARK 的 reasoning_content 字段）
    const reasoningContent: string = assistantMsg?.reasoning_content || '';
    if (reasoningContent) {
      console.log(`[Gemini][THINKING] round=${round} len=${reasoningContent.length} preview="${reasoningContent.slice(0, 200).replace(/\n/g, '↵')}"`);
    }
    console.log(
      `[Gemini][${logLevel}] round=${round} finish_reason=${finishReason}` +
      ` prompt_tokens=${usage.prompt_tokens ?? '?'}` +
      ` completion_tokens=${usage.completion_tokens ?? '?'}` +
      ` reasoning_tokens=${usage.completion_tokens_details?.reasoning_tokens ?? 0}` +
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
        // Step 6 (v2): 查询工单/报告内容（JOIN skills获取skill_name，JOIN ticket_results获取报告）
        let ticket: any = null;
        try {
          ticket = await db.getAsync<any>(
            `SELECT t.id, t.skill_id, t.token, s.name as skill_name, t.status, t.created_at,
                    tr.raw_result, tr.report_url
             FROM tickets t
             LEFT JOIN ticket_results tr ON tr.ticket_id = t.id
             LEFT JOIN skills s ON s.id = t.skill_id
             WHERE t.created_by=? AND t.status IN ('done','processing','submitted','waiting_input','created')
             ORDER BY t.created_at DESC LIMIT 1`,
            [userId || ''],
          );
        } catch (qerr: any) {
          console.error(`[Gemini] ❌ query_ticket SQL error userId=${userId}: ${qerr?.message}`);
          // fallback: 无 JOIN 版本（兜底）
          try {
            ticket = await db.getAsync<any>(
              `SELECT t.id, t.skill_id, t.token, t.status, t.created_at
               FROM tickets t
               WHERE t.created_by=? AND t.status IN ('done','processing','submitted','waiting_input','created')
               ORDER BY t.created_at DESC LIMIT 1`,
              [userId || ''],
            );
            console.log(`[Gemini] 📋 query_ticket fallback (no JOIN) → ticket_id=${ticket?.id}`);
          } catch (ferr: any) {
            console.error(`[Gemini] ❌ query_ticket fallback error: ${ferr?.message}`);
          }
        }

        if (ticket) {
          const reportContent = ticket.raw_result || null;
          // waiting_input 状态：构造 H5 填写链接
          let fillUrl: string | null = null;
          if (ticket.status === 'waiting_input' && ticket.token) {
            const h5BaseRow = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', ['h5_base_url']).catch(() => null);
            const serviceUrl = process.env.PUBLIC_BASE_URL || '';
            const h5Base = h5BaseRow?.value || `${serviceUrl}/h5`;
            fillUrl = `${h5Base}?token=${ticket.token}`;
          }
          result = JSON.stringify({
            ticket_id:   ticket.id,
            skill_name:  ticket.skill_name || ticket.skill_id,
            status:      ticket.status,
            status_desc: ticket.status === 'waiting_input'  ? '工单等待填写。仅当用户明确询问工单填写链接时，才把 fill_url 发给用户，其他情况不要主动推送'
                       : ticket.status === 'submitted'      ? '您已提交，等待分析'
                       : ticket.status === 'processing'     ? 'AI正在分析中'
                       : ticket.status === 'done'           ? '分析已完成'
                       : ticket.status === 'created'        ? '已创建待处理'
                       : ticket.status,
            fill_url:    fillUrl,
            report:      reportContent || '（报告尚未生成）',
            report_url:  ticket.report_url || null,
            created_at:  ticket.created_at,
          });
          console.log(`[Gemini] 📋 query_ticket → ticket_id=${ticket.id} status=${ticket.status} fill_url=${fillUrl ? '有' : '无'} report_len=${reportContent?.length || 0}`);
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
    const model = process.env.ARK_MODEL || 'deepseek-v4-flash-ga-260731';  // ARK 기본 모델
    return { type: type || 'chat', durationMs, systemPrompt, userMsg, rawResult: result.trim(), model };
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.warn('[AgentService] Route call failed, defaulting to chat:', err);
    return { type: 'chat', durationMs, systemPrompt, userMsg, rawResult: '(error)', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' };
  }
}

// ─── 2. 自动 Skill 路由（从可用 skill 中选最合适的一个）────────────────────────

let _skillsCache: { id: string; name: string; description: string }[] | null = null;
let _skillsCacheExpire = 0;

async function getAvailableSkills(profile: AgentProfile): Promise<{ id: string; name: string; description: string }[]> {
  if (_skillsCache && Date.now() < _skillsCacheExpire) return _skillsCache;
  let skills: any[];
  if (profile.skill_mode === 'auto') {
    skills = await db.allAsync<any>(
      "SELECT id, name, description FROM skills WHERE status = 'published' ORDER BY name",
      []
    );
  } else {
    if (!profile.skill_ids.length) { _skillsCache = []; _skillsCacheExpire = Date.now() + 30_000; return []; }
    const placeholders = profile.skill_ids.map(() => '?').join(',');
    skills = await db.allAsync<any>(
      `SELECT id, name, description FROM skills WHERE status = 'published' AND id IN (${placeholders}) ORDER BY name`,
      profile.skill_ids
    );
  }
  const result = skills.map(s => ({ id: s.id, name: s.name, description: s.description || '' }));
  _skillsCache = result;
  _skillsCacheExpire = Date.now() + 30_000;  // 30s cache
  return result;
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
// 路由决策缓存（TTL=30s）——相同内容的相邻请求直接复用，避免首次调用 ~5s 延迟
interface RouteCacheEntry { result: RouteDecisionResult; expireAt: number; }
const _routeCache = new Map<string, RouteCacheEntry>();
const ROUTE_CACHE_TTL_MS = 30_000;

function _routeCacheKey(content: string, skillIds: string[]): string {
  const contentSnip = content.trim().slice(0, 80);
  return `${contentSnip}||${skillIds.sort().join(',')}`;
}

async function routeDecision(
  content: string,
  history: { role: string; content: string }[],
  notes: string,
  availableSkills: { id: string; name: string; description: string }[],
  apiKey: string,
): Promise<RouteDecisionResult> {
  const model = process.env.ARK_MODEL || 'deepseek-v4-flash-ga-260731';

  // 缓存命中时直接返回
  const cacheKey = _routeCacheKey(content, availableSkills.map(s => s.id));
  const cached = _routeCache.get(cacheKey);
  if (cached && Date.now() < cached.expireAt) {
    console.log(`[RouteDecision] cache hit (${Math.round((cached.expireAt - Date.now()) / 1000)}s left): confidence=${cached.result.confidence}`);
    return cached.result;
  }

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
    const rdResult = { skill_id: finalSkillId, skill_name: finalSkillName, skill_desc: finalSkillDesc,
             confidence, reason: parsed.reason || '', durationMs, model, rawResult: result.trim() };
    // 写入缓存
    _routeCache.set(cacheKey, { result: rdResult, expireAt: Date.now() + ROUTE_CACHE_TTL_MS });
    return rdResult;

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
    // V3.5：信息式提示 + 括号简介 + 明确不要求确认 + 用户拒绝时的保护语
    const shortDesc = routeSkillDesc ? `（${routeSkillDesc.slice(0, 60)}）` : '';
    directive = `[服务匹配提示] 系统检测到用户可能对「${routeSkillName}」感兴趣（置信度：高）。`
      + `如果当前对话场景自然合适，可顺带提及${shortDesc}；`
      + `不必要求用户确认，感兴趣自然会主动询问。`
      + `若用户正在聊别的事，正常回答即可。`
      + `若用户明确表示不需要推荐、或已有专业服务，不必提及。`;


  } else if (guardStatus === 'confirmed_ticket' && ticketUrl) {
    directive = `用户已确认使用「${guardSkillName || routeSkillName || ''}」，工单已建立。`
      + `\n工单链接：${ticketUrl}`
      + `\n请告知用户工单已创建，引导他点击链接填写问卷。直接使用以上链接，不要自己生成链接。`;

  } else if (guardStatus === 'declined') {
    directive = `用户明确拒绝了「${guardSkillName || ''}」服务，守卫已关闭。请正常回答用户的问题。`;

  } else if (guardStatus === 'pending_unclear' && guardSkillName) {
    if (routeSkillId && routeSkillId !== (params.recentTicket?.skill_id) && routeSkillName !== guardSkillName) {
      // 话题跳到不同 skill
      directive = `用户对「${guardSkillName}」服务有意向但尚未确认。`
        + `本次消息话题指向其他方向，请先回答用户的问题，不必重复推荐服务。`;
    } else if ((params as any).isFirstClarify) {
      // 首次模糊确认 → 软提示，不强制追问
      directive = `[服务匹配提示] 用户此前对「${guardSkillName}」有一定意向，但尚未明确确认。`
        + `先回答用户的问题；如果回复末尾有自然的空间，可以轻轻问一句是否想使用，不必强求。`;
    } else {
      // 已追问过或用户在提问 → 先回答，顺带引导
      directive = `用户对「${guardSkillName}」服务有意向但尚未明确确认。`
        + `\n请先回答用户的问题，如果对话场景合适，在回复末尾轻描淡写地引导用户确认是否使用该服务（不要强迫）。`;
    }

  } else if (guardStatus === 'none' && existingTicket) {
    if (existingTicket.status === 'processing' || existingTicket.status === 'submitted') {
      // 只有当前意向 skill 与进行中工单一致时才注入 directive
      if (!routeSkillId || existingTicket.skillId === routeSkillId) {
        directive = `用户有一个进行中的「${existingTicket.skillName}」工单（状态：处理中）。`
          + `如果用户在询问进度，告知「正在分析，完成后会通知您」。`;
      }
    } else if (existingTicket.status === 'done' && existingTicket.reportContent) {
      // 报告已完成且有内容：主动告知用户报告已生成
      if (!routeSkillId || existingTicket.skillId === routeSkillId) {
        directive = `用户的「${existingTicket.skillName}」分析报告已完成，请直接告知用户报告已生成（报告原文见下方）。`
          + `如用户询问具体建议或细节，请结合下方报告内容回答；`
          + (existingTicket.reportUrl ? `如用户询问报告在哪查看，提供此链接：${existingTicket.reportUrl}` : `告知报告内容已在此对话中呈现`);
      }
    } else if (existingTicket.status === 'done') {
      if (!routeSkillId || existingTicket.skillId === routeSkillId) {
        directive = `用户的「${existingTicket.skillName}」分析报告已完成，请告知用户报告已生成。`
          + (existingTicket.reportUrl ? `\n报告查看链接：${existingTicket.reportUrl}` : '');
      }
    } else if (existingTicket.status === 'waiting_input') {
      // ⚠️ 关键：只有当前意向 skill 与待填写工单 skill 一致时才提示填写
      // 如果用户正在问别的 skill，不应用旧工单打断用户意图
      if (!routeSkillId || existingTicket.skillId === routeSkillId) {
        directive = `用户有一个待填写的「${existingTicket.skillName}」工单。`
          + (existingTicket.h5Url
            ? `\n请提示用户点击以下链接完成填写：${existingTicket.h5Url}`
            : `\n请告知用户工单已创建，稍后会收到填写链接通知。`);
      }
      // routeSkillId 与 existingTicket.skillId 不同时 → directive 为空，Agent 正常按新意向回答
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
- 如客户涉及具体健康问题，结合健康档案直接给出简洁的专业建议
- 绝对不要说"正在分析"、"请稍等"、"马上回复"等让用户等待的话，你必须直接回答
- 绝对不要自己生成任何链接（URL），尤其不要生成 h5?token= 类的工单链接。如果客户想使用分析服务，告知"好的，为您安排"即可，系统会自动处理
- 客户发送文件/图片时（消息包含 [文件:] 或 [图片]），先简单确认收到并询问需求，**不要主动调用 query_ticket 工具、不要主动提及或推送任何已有工单链接**
- 只有当客户**明确询问**工单进度、报告状态（如"工单进行到哪了"、"报告出来了吗"、"之前提交的分析怎么样了"）时，才调用 query_ticket 工具查询，再据实回答；工单状态处理规则：
  「waiting_input」= 用户已有待填写工单，把 fill_url 链接发给用户引导填写（绝对不要再问用户是否想用该服务，他们已经确认过了）；如 fill_url 为 null 则告知工单已建但链接加载失败
  「submitted/processing」= AI 分析中，告知预计时间
  「done」= 分析已完成。根据用户意图：若问具体健康建议（如"能换牛奶吗"），必须先引用 report 字段内容回答再附 report_url；若只问"报告在哪"则直接给 report_url；无论哪种情况，服务名必须用 skill_name 字段原文
  「created」= 已创建待处理，告知工单已建即可
  「expired」= 已过期，可重新开始
- ⚠️ 关键：回复中提到服务名时，永远使用 query_ticket 返回的 skill_name 原文，不要替换成对话中出现过的其他服务名`;

  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content },
  ];

  const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024, {
    tools:      WIKI_TOOLS,   // 含 query_ticket，让 AI 按需查工单
    userId:     meta.user_id,
    onToolCall: (name, _args, result) => {
      if (name === 'query_ticket') {
        void appendTaskEvent(requestId, 'tool_query_ticket', {
          userId: meta.user_id,
          result: (() => { try { return JSON.parse(result); } catch { return result; } })(),
        });
        console.log(`[AgentService] 🔧 [Chat] tool_query_ticket 已触发 userId=${meta.user_id}`);
      }
    },
  });

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
  agentCtxPkg?: AgentContextPackage,   // Step 5 组装的上下文包（含 directive + existingTicket）
): Promise<AgentResponse> {
  const { content, meta, history = [], notes = '' } = req;
  const wikiCtx = (req as any)._wikiContext as { user_profile: string; health_wiki: string } | undefined;
  const fromName = meta.from_name || '您';

  const tabooText = profile.taboos.length ? `\n\n禁忌：\n${profile.taboos.map(t => `- ${t}`).join('\n')}` : '';
  const profileBlock = wikiCtx?.user_profile ? `\n\n【客户画像】\n${wikiCtx.user_profile}` : '';
  const healthBlock = wikiCtx?.health_wiki ? `\n\n【健康档案摘要】\n${wikiCtx.health_wiki}` : '';

  // ── 工单 / 守卫 directive 块（来自 agentCtxPkg）────────────────────────────────────────
  const directiveBlock = agentCtxPkg?.directive
    ? `\n\n【当前任务指令】\n${agentCtxPkg.directive}`
    : '';
  // 注意：不在 prompt 中注入报告原文（reportBlock），让 AI 通过 query_ticket 工具获取报告
  // 这样可确保 tool_query_ticket 事件被记录，保证日志链完整性

  const systemPrompt = `你是${profile.name}，${profile.role_desc || '专业的健康顾问'}，根据客户的健康档案和问题提供专业且个性化的建议。
回复风格：${profile.reply_style || '亲切专业，回复控制在300字以内'}${tabooText}${profileBlock}${healthBlock}${directiveBlock}

要求：
- 不要使用 Markdown 格式
- 如无健康档案，基于对话内容给出通用建议`;

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
         AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        [meta.user_id, skillId, oneHourAgo, Date.now()]
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
          // Bug2 修复：检测重做意图（「重来/再做」等）→ expire 旧工单，fall-through 新建
          const wantsRedo = /重新|再做|再来|新的|重来|重做/.test(content);
          if (wantsRedo) {
            await db.runAsync(
              `UPDATE tickets SET status='expired', updated_at=? WHERE id=?`,
              [Date.now(), existing.id]
            );
            console.log(`[AgentService] 🔄 用户要求重做，旧工单 ${existing.id} → expired，将新建工单`);
            // reply 为空 → 跳过 if(reply) 块，继续新建工单
          } else {
            reply = `${fromName}，您的「${skillName}」分析报告已生成 🎉\n\n点击查看报告：\n${reportUrl}`;
          }
        } else if (existing.status === 'returned') {
          const reason = existing.return_reason ? `\n原因：${existing.return_reason}\n\n` : '\n\n';
          reply = `${fromName}，工作人员已审阅并打回您的「${skillName}」工单，请重新填写：${reason}${exUrl}`;
        }

        if (reply) {
          // 把当前 requestId 写入票据，供后续回调写 AgentLogs 使用
          void db.runAsync(
            `UPDATE tickets SET request_id=?, updated_at=? WHERE id=?`,
            [requestId, Date.now(), existing.id]
          );
          void appendTaskEvent(requestId, 'ticket_reused', { ticketId: existing.id, status: existing.status });
          // done 状态：立即写 skill_done + reply_sent（不等回调）
          if (existing.status === 'done') {
            void appendTaskEvent(requestId, 'skill_done', {
              ticketId: existing.id, skillName,
              outputLen: (existing.raw_result || reply).length,
              output_preview: reply.slice(0, 200),
              report_url: reportUrl,
            });
            void appendTaskEvent(requestId, 'reply_sent', {
              reply: reply.slice(0, 300),
              channel: delivery?.app, recipient: delivery?.recipient,
              note: 'ticket_reused_done',
            });
          }
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

      // ── 跨 skill 重做：同 skill 没找到 done 工单，但用户有重做意图 → 查所有 skill 的 done 工单并 expire ──
      const wantsRedoCross = /重新|再做|再来|新的|重来|重做/.test(content);
      if (wantsRedoCross) {
        const doneTickets = await db.allAsync<any>(
          `SELECT id, skill_id FROM tickets WHERE created_by=? AND status='done' AND created_at > ?
           ORDER BY created_at DESC`,
          [meta.user_id, oneHourAgo]
        ).catch(() => [] as any[]);
        for (const dt of doneTickets) {
          await db.runAsync(
            `UPDATE tickets SET status='expired', updated_at=? WHERE id=?`,
            [Date.now(), dt.id]
          );
          console.log(`[AgentService] 🔄 跨skill重做，旧工单 ${dt.id} (skill=${dt.skill_id}) → expired`);
        }
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

    // ── 从 wiki 提取 H5 表单预填字段 ─────────────────────────────────────────
    const wikiText = [wikiCtx?.user_profile || '', wikiCtx?.health_wiki || ''].join('\n');
    const ageMatch  = wikiText.match(/(\d{1,3})\s*(?:岁|歲|years?\s*old)/i);
    const phoneMatch= wikiText.match(/1[3-9]\d{9}/);

    const now = Date.now();

    // ── 系统自动查询 24 小时内用户发送的附件 ─────────────────────────────────
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    let recentFiles: any[] = [];

    if (meta.user_id) {
      try {
        const uId = String(meta.user_id);
        const wecomUid = uId.startsWith('wecom_') ? uId : `wecom_${uId}`;
        const rawUid = uId.replace(/^wecom_/, '');
        recentFiles = await db.allAsync<any>(
          `SELECT * FROM user_recent_files WHERE (user_id=? OR user_id=? OR user_id=?) AND created_at > ? ORDER BY created_at DESC LIMIT 5`,
          [uId, wecomUid, rawUid, oneDayAgo]
        );
      } catch (err: any) {
        console.warn('[AgentService] 查询最近附件失败:', err.message);
      }
    }


    const prefilledFiles = recentFiles.map(f => ({
      id: f.id,
      name: f.file_name || '附件',
      url: f.file_url,
      type: f.file_type || 'file',
      summary: f.summary || '',
    }));

    const prefilledValues: Record<string, any> = {
      contact_name:            meta.from_name || '',
      patient_name:            meta.from_name || '',
      patient_age:             ageMatch ? ageMatch[1] : '',
      contact_phone:           phoneMatch ? phoneMatch[0] : '',
      additional_health_info:  wikiCtx?.health_wiki ? wikiCtx.health_wiki.slice(0, 300).replace(/\[🔗.*?\]\(.*?\)/g, '').trim() : '',
      prefilled_files:         prefilledFiles,
    };
    const prefilledValuesJson = JSON.stringify(prefilledValues);

    const ticketId = require('crypto').randomUUID();
    const token    = require('crypto').randomUUID().replace(/-/g, '');
    const expiresAt = now + 60 * 60 * 1000; // 1小时有效

    const deliveryInfo = JSON.stringify({
      callback_url:   req.callback_url || '',
      app:            delivery.app,
      recipient:      delivery.recipient,
      action:         delivery.action,
      source_channel: (req as any).source_channel || req.source || '',
      juhe_conv_id:   (req as any).meta?.juhe_conv_id || '',
    });

    await db.runAsync(
      `INSERT INTO tickets
        (id, skill_id, token, title, patient_name, notes,
         created_by, status, return_count, expires_at, created_at, updated_at, delivery_info, request_id, prefilled_values)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticketId, skillId, token,
       `${skillName} — ${fromName} — ${new Date(now).toLocaleDateString('zh-CN')}`,
       patientName, prefilledNotes,
       meta.user_id || null, 'waiting_input', 0, expiresAt, now, now, deliveryInfo, requestId, prefilledValuesJson],
    );

    // ── 将最近附件默认写入 ticket_inputs（系统自动挂载）───────────────────────
    for (const f of prefilledFiles) {
      await db.runAsync(
        `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [require('crypto').randomUUID(), ticketId, 'file', 'file', f.url, f.name, f.type === 'image' ? 'image/jpeg' : 'application/pdf', now]
      );
    }
    if (prefilledFiles.length > 0) {
      console.log(`[AgentService] 📎 系统自动挂载 ${prefilledFiles.length} 份24小时内附件到工单 ${ticketId}: ${prefilledFiles.map(f => f.name).join(', ')}`);
    }

    const ticketUrl  = `${h5Base}?token=${token}`;
    const fileHint = prefilledFiles.length > 0 ? `（已为您自动载入：${prefilledFiles.map(f => f.name).join('、')}）` : '';
    const replyToUser = `${fromName}，已为您创建「${skillName}」分析工单 🎉\n\n我们已根据您的健康档案预填了信息${fileHint}，请点击以下链接确认并补充，提交后 AI 将为您生成专属分析报告：\n\n${ticketUrl}`;


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
  const effectiveModel = skillRow?.preferred_model || 'deepseek-v4-flash-ga-260731';
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
  // 凭证通过 getAICredentials() 缓存获取，不重复查 DB
  const creds = await getAICredentials();
  if (!creds.apiKey) throw new Error('AI credentials not configured. Set DOUBAO_API_KEY or GEMINI_API_KEY.');
  const apiKey = creds.apiKey;  // 保持下方代码兼容

  const requestId  = `req_${uuidv4().replace(/-/g, '').slice(0, 10)}`;
  const serviceUrl = process.env.SERVICE_URL || '';
  const taskStartMs = Date.now();

  const app       = req.context.available_apps?.[0] || '企业微信';
  const recipient = req.context.current_recipient || req.meta.from_name || '';
  const delivery: AgentDelivery = { app, recipient, action: 'type_and_send' };

  const userId      = req.meta?.user_id || '';
  const sessionId   = req.session_id || userId;
  const srcChannel  = (req as any).source_channel || req.source || 'wecom';
  // juhe channel: agent_tasks 存原始 channel_uid（vid），
  // 方便 JUHE-3 测试通过 JUHE_USER_ID 查到任务；
  // wiki/tickets 仍用 unified_id（req.meta.user_id）
  const taskUserId = srcChannel === 'juhe' && (req.meta as any)?.channel_uid
    ? ((req.meta as any).channel_uid as string)
    : userId;

  console.log(`[AgentService] request_id=${requestId} session=${sessionId} source=${srcChannel}`);

  // ── 创建 agent_task 记录（await 确保写入，不受 fire-and-forget 影响）──────────
  await createAgentTask({
    id: requestId, sessionId, userId: taskUserId, sourceChannel: srcChannel,
    inputContent: req.content,
    meta: { from_name: req.meta?.from_name, employee: (req.meta as any)?.employee, channel_uid: (req.meta as any)?.channel_uid },
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

  // ── 第三道防线：纯文件占位内容不回复 ────────────────────────────────────────
  // 正常流程下文件消息被 ingest 守卫拦截（第二道），archiver 拦截（第一道）
  // 但如果消息意外到达这里（直接调 /api/v1/agent/chat），也要保持静默
  // 判断：content 以 [文件: 开头 且 不包含用户文字（无换行/空格后跟正文）
  const isFileOnlyContent = /^\[文件:/.test(req.content.trim()) && !req.content.includes('\n');
  if (isFileOnlyContent) {
    console.log(`[AgentService][FileGuard] ${requestId} content is file-only placeholder, returning silent`);
    void updateAgentTask(requestId, { status: 'done', result: '(file-only: silent)' });
    void appendTaskEvent(requestId, 'file_only_silent', { reason: '纯文件占位符，不回复用户' });
    return { reply: '', route_type: 'file_saved' };
  }

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

  // ── Step 0.9: Skill 确认守卫存在性检查（AI判断移至路由后 Step 4，plan 1.2/1.3）────
  // 只检查守卫是否存在 + 轮次限制，不在路由前做 AI 判断。
  // 守卫 AI 判断（yes/unclear/no）在 routeDecision 之后、Step 4 里运行。
  let currentGuardStatus: GuardStatus = 'none';      // Step 5 (v2): 追踪守卫状态
  let currentGuardSkillName: string | null = null;   // Step 5 (v2): 守卫对应的 skill
  let isFirstClarify = false;                        // 首次 unclear → Agent 主动引导
  let activeGuardRow: any = null;                    // 非 null = 守卫有效且未超轮次，留给 Step 4

  if (sessionId) {
    const nowMs = Date.now();
    const activeGuard = await db.getAsync<any>(
      `SELECT * FROM skill_confirm_guards
       WHERE session_id=? AND status='active' AND expires_at>?
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, nowMs],
    );
    if (activeGuard) {
      const MAX_GUARD_ROUNDS = 10;
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
      void appendTaskEvent(requestId, 'guard_lifecycle', {
        action: 'existing',
        guardId: activeGuard.id,
        skillId: activeGuard.skill_id,
        skillName: activeGuard.skill_name,
        round: newCheckCount,
      });
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
        // 超轮后守卫关闭，activeGuardRow 保持 null，后续按无守卫处理
      } else {
        activeGuardRow        = activeGuard;       // 守卫有效，留给 Step 4 路由后判断
        currentGuardStatus    = 'pending_unclear'; // 预设；Step 4 判断后会更新
        currentGuardSkillName = activeGuard.skill_name;
      }
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
      reason: routeReason, forced: true, durationMs: 0,
    });
  } else {
    // 正常路由：单次 AI 调用（v2）
    const rdResult = await routeDecision(
      req.content,  // 守卫判断已移至路由后，无需 guardHint
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
    });
  }

  // ── Step 3 (v2): confidence=none → 普通聊天，直接 Agent 回复 ─────────────────
  // ⚠️ 例外：pending_unclear 时必须走 handleHealthDirect（注入 directive），不走 handleChatReply
  if (routeConfidence === 'none' && currentGuardStatus !== 'pending_unclear') {
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

  // ── Step 4 (v2): 路由后守卫管理 + 守卫 AI 判断（plan 1.2 规则A/B）────────────────────
  // 规则 A：有活跃守卫 → 无条件运行守卫判断（不依赖 routeConfidence）
  //   「好的」「不用了」等确认/拒绝消息路由往往返回 none，
  //   守卫判断必须独立于路由结果运行，才能正确检测 confirm=yes/no。
  //   例外：跨 skill（routing=high 且指向不同 skill）→ 关闭旧守卫，走规则 B 建新守卫。
  // 规则 B：无守卫 + routing=high → 新建守卫（Agent 介绍服务）
  // 1小时内同skill有活跃工单 → 跳过守卫介绍轮，直接走 handleHealthSkill 的状态判断
  // 覆盖所有非 error/expired 状态：
  //   waiting_input   → 固定话术「已有工单，点击填写」
  //   submitted       → 固定话术「处理中」
  //   processing      → 固定话术「处理中」
  //   done            → 固定话术「报告已生成」或重做意图→expire→新建
  //   returned        → 固定话术「已打回，重新填写」
  //   patient_rejected/patient_confirmed → reply='' → fall-through → 新建工单
  const oneHourAgoForGuard = Date.now() - 60 * 60 * 1000;
  const recentTicketStatus  = ctxSnapshot.recentTicket?.status || '';
  const recentTicketSkillId = ctxSnapshot.recentTicket?.skill_id || '';
  const recentTicketAge     = Number(ctxSnapshot.recentTicket?.created_at || 0);
  const ticketBlocked = !!(
    ctxSnapshot.recentTicket
    && recentTicketAge > oneHourAgoForGuard
    && recentTicketSkillId === selectedSkillId
    && !['error', 'expired'].includes(recentTicketStatus)
  );

  // ── 规则 A: 有活跃守卫 → 判断（不管 routing 结果）──────────────────────────────
  if (activeGuardRow && !forcedSkillId && !ticketBlocked) {
    // 跨 skill 切换：routing=high 且指向不同 skill → 关闭旧守卫，走规则 B 建新守卫
    const crossSkill = routeConfidence === 'high' && selectedSkillId && selectedSkillId !== activeGuardRow.skill_id;

    if (crossSkill) {
      try {
        await db.runAsync(
          `UPDATE skill_confirm_guards SET status='closed', close_reason='closed_by_new_skill' WHERE id=?`,
          [activeGuardRow.id],
        );
        console.log(`[SkillGuard] 🔄 跨skill切换：关闭旧守卫 id=${activeGuardRow.id} skill=${activeGuardRow.skill_name}`);
        void appendTaskEvent(requestId, 'guard_lifecycle', {
          action: 'closed_by_new_skill',
          guardId: activeGuardRow.id,
          oldSkillId: activeGuardRow.skill_id,
          oldSkillName: activeGuardRow.skill_name,
          newSkillId: selectedSkillId,
          newSkillName: selectedSkillName,
        });
      } catch (e: any) {
        console.warn(`[SkillGuard] ⚠️ 关闭旧守卫失败: ${e.message}`);
      }
      // currentGuardStatus 保持 'none'，允许规则 B 建新守卫
    } else {
      // ─ 同 skill 守卫 OR 确认/拒绝消息（routing=none/low）→ 守卫 AI 判断 ────
      console.log(`[SkillGuard] 🔍 守卫判断 guardId=${activeGuardRow.id} skill=${activeGuardRow.skill_name} routeConf=${routeConfidence}`);

      const historyAfterSuggest = (req.history || [])
        .filter((h: any) => !h.ts || h.ts >= activeGuardRow.suggest_ts)
        .map((h: any) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`)
        .join('\n');

      const guardSystemPrompt = `你是一个 JSON 状态判断器。禁止输出推理过程或解释，只输出一个 JSON 对象，不包含任何其他文字。

背景：AI助手之前向用户推荐了「${activeGuardRow.skill_name}」服务。

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
          guardId: activeGuardRow.id,
          skillName: activeGuardRow.skill_name,
          interest: guardResult.interest,
          confirm: guardResult.confirm,
          durationMs,
          rawResult: raw.slice(0, 300),
        });
      } catch (e: any) {
        console.warn(`[SkillGuard] ⚠️ 判断失败，保持 unclear: ${e.message}`);
        void appendTaskEvent(requestId, 'skill_guard_judgment', {
          guardId: activeGuardRow.id,
          error: e.message,
          interest: 'yes',
          confirm: 'unclear',
        });
      }

      const closeGuard = async (reason: string) => {
        await db.runAsync(
          `UPDATE skill_confirm_guards SET status='closed', close_reason=? WHERE id=?`,
          [reason, activeGuardRow.id],
        );
        console.log(`[SkillGuard] 🔒 守卫已关闭 id=${activeGuardRow.id} reason=${reason}`);
        void appendTaskEvent(requestId, 'skill_guard_closed', {
          guardId: activeGuardRow.id,
          skillName: activeGuardRow.skill_name,
          reason,
        });
      };

      if (guardResult.interest === 'no') {
        await closeGuard('user_declined');
        currentGuardStatus    = 'declined';
        currentGuardSkillName = activeGuardRow.skill_name;
        selectedSkillId   = null;
      } else if (guardResult.confirm === 'yes') {
        await closeGuard('user_confirmed');
        console.log(`[SkillGuard] ✅ 用户确认，执行 skill ${activeGuardRow.skill_id}`);
        currentGuardStatus    = 'confirmed_ticket';
        currentGuardSkillName = activeGuardRow.skill_name;
        // 确认消息本身 routing 可能是 none → 强制注入守卫的 skill
        selectedSkillId   = activeGuardRow.skill_id;
        selectedSkillName = activeGuardRow.skill_name;
        selectedSkillDesc = availableSkills.find(s => s.id === activeGuardRow.skill_id)?.description || null;
      } else if (guardResult.confirm === 'no') {
        await closeGuard('user_declined_explicit');
        currentGuardStatus    = 'declined';
        currentGuardSkillName = activeGuardRow.skill_name;
        selectedSkillId   = null;
      } else {
        // unclear
        const isUserAsking = req.content.includes('？') || req.content.includes('?');
        const prevClarifyCount = await db.getAsync<any>(
          `SELECT COUNT(*) as cnt FROM agent_task_events
           WHERE event_type='skill_guard_clarify'
             AND JSON_EXTRACT(payload,'$.guardId')=?`,
          [activeGuardRow.id],
        ).then((r: any) => r?.cnt || 0).catch(() => 0);

        if (!isUserAsking && prevClarifyCount === 0) {
          void appendTaskEvent(requestId, 'skill_guard_clarify', {
            guardId: activeGuardRow.id,
            skillName: activeGuardRow.skill_name,
            note: '首次unclear→交给Agent引导',
          });
          isFirstClarify = true;
        }
        currentGuardStatus    = 'pending_unclear';
        currentGuardSkillName = activeGuardRow.skill_name;
        selectedSkillId   = null;
      }
    }
  }

  // ── 规则 B: 无守卫（或刚跨skill关闭）+ routing=high → 新建守卫 ──────────────────────────
  if (currentGuardStatus === 'none'
      && routeConfidence === 'high' && selectedSkillId && selectedSkillName
      && !forcedSkillId && !ticketBlocked) {

    const newGuardSkillId   = selectedSkillId;
    const newGuardSkillName = selectedSkillName;
    const guardId = `guard_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const nowTs = Date.now();
    try {
      await db.runAsync(
        `INSERT INTO skill_confirm_guards
          (id, session_id, user_id, skill_id, skill_name, suggest_msg, suggest_ts, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [guardId, sessionId, userId, newGuardSkillId, newGuardSkillName,
         '', nowTs, nowTs, nowTs + 30 * 60 * 1000],
      );
      console.log(`[SkillGuard] 🛡️ guard 已激活 id=${guardId} skill=${newGuardSkillName} session=${sessionId}`);
      void appendTaskEvent(requestId, 'skill_guard_activated', {
        guardId, skillId: newGuardSkillId, skillName: newGuardSkillName,
        expiresAt: new Date(nowTs + 30 * 60 * 1000).toISOString(),
      });
      void appendTaskEvent(requestId, 'guard_lifecycle', {
        action: 'new_created', guardId,
        skillId: newGuardSkillId, skillName: newGuardSkillName,
        expiresAt: new Date(nowTs + 30 * 60 * 1000).toISOString(),
      });
      void appendTaskEvent(requestId, 'skill_suggest', {
        skillId: newGuardSkillId, skillName: newGuardSkillName, reason: routeReason,
      });
    } catch (e: any) {
      console.warn(`[SkillGuard] ⚠️ guard 创建失败: ${e.message}`);
    }

    currentGuardStatus    = 'new_created';
    currentGuardSkillName = newGuardSkillName;
    selectedSkillId = null;  // → handleHealthDirect（Agent 通过 directive 介绍服务）
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
  // 例外：守卫已确认（confirmed_ticket）→ 必须执行，不受 confidence=low 影响
  if (routeConfidence === 'low' && selectedSkillId && currentGuardStatus !== 'confirmed_ticket') {
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
    // INT-8 fix: handleHealthSkill 路径也发 agent_context_assembled（便于日志链完整性检查）
    void appendTaskEvent(requestId, 'agent_context_assembled', {
      guardStatus:  currentGuardStatus,
      routeSkill:   selectedSkillName,
      confidence:   routeConfidence,
      hasTicket:    !!ctxSnapshot.recentTicket,
      ticketStatus: ctxSnapshot.recentTicket?.status || null,
      directive:    'handleHealthSkill path',
    });
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
    //   pending_unclear= 守卫存在但用户未确认（保留守卫，Agent 引导确认）
    //   declined       = 用户拒绝了守卫，正常回答
    //   new_created    = 守卫刚新建（Agent 介绍服务，询问是否确认），是正常的首次推荐路径
    //   confirmed_ticket= 用户已确认 → 走 handleHealthSkill，不到这里
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
      isFirstClarify,                          // Step 7fix: 首次 unclear 需要 Agent 主动引导
    } as any);

    void appendTaskEvent(requestId, 'agent_context_assembled', {
      guardStatus:   agentCtxPkg.guardStatus,
      routeSkill:    agentCtxPkg.routeSkillName,
      confidence:    agentCtxPkg.routeConfidence,
      hasTicket:     !!agentCtxPkg.existingTicket,
      ticketStatus:  agentCtxPkg.existingTicket?.status || null,
      directive:     agentCtxPkg.directive?.slice(0, 200) || '',
    });
    console.log(`[AgentService] 📦 agent_context_assembled: guardStatus=${agentCtxPkg.guardStatus} directive=${agentCtxPkg.directive?.slice(0,50)||'(none)'}`);

    const directResult = await handleHealthDirect(req, apiKey, requestId, delivery, profile, skillRouteLog, agentCtxPkg);
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
