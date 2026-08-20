/**
 * dispatcherService.ts
 *
 * 出站消息分发器（Egress Dispatcher）
 *
 * 职责：
 *   1. enqueueDelivery(opts) → INSERT delivery_queue（持久化，<5ms，不阻塞主流程）
 *   2. startDispatcherLoop()  → 独立 setInterval，每 5s 扫 pending jobs 并发送
 *
 * 发送优先级（按 delivery_routes 顺序）：
 *   1. juhe（直发，低延迟）
 *   2. CUA fallback（桌面操控，高延迟但兜底）
 *
 * 重试策略：5s → 30s → 120s（共 3 次），超出 → status='dead'
 *
 * 并发安全：乐观锁 UPDATE status='processing' WHERE status='pending'
 *           防止多进程重复处理同一 job
 */

import { v4 as uuidv4 } from 'uuid';
import * as db from './db';

const JUHE_SEND_URL = process.env.JUHE_SEND_URL || '';
const CUA_SEND_URL  = process.env.CUA_SEND_URL  || '';

const RETRY_DELAYS_MS      = [5_000, 30_000, 120_000];  // 指数退避
const MAX_RETRY            = RETRY_DELAYS_MS.length;     // 3 次
const DISPATCH_INTERVAL_MS = 5_000;                      // 每 5s 扫一次

interface DeliveryRoute {
  channel:      string;
  channel_uid:  string;
  conv_id:      string | null;
  display_name: string;
}

interface EnqueueOpts {
  taskId:     string;
  customerId: string;
  reply:      string;
  routes:     DeliveryRoute[];
  // 用于 CUA fallback 的额外上下文
  requestId?: string;
  sessionId?: string;
  status?:    string;
  reasoning?: string;
  delivery?:  any;
}

/**
 * 将出站消息入队（持久化）。
 * 非阻塞：调用方 await 也只等 INSERT，不等实际发送。
 */
export async function enqueueDelivery(opts: EnqueueOpts): Promise<void> {
  const { taskId, customerId, reply, routes, requestId, sessionId, status, reasoning, delivery } = opts;
  const id  = uuidv4();
  const now = Date.now();

  // 把 _ctx 附在 routes JSONB 里，避免加额外列
  const routesWithCtx = {
    _routes: routes,
    _ctx:    { requestId, sessionId, status, reasoning, delivery },
  };

  await db.runAsync(
    `INSERT INTO skill_platform.delivery_queue
       (id, task_id, customer_id, reply, routes, status, retry_count, retry_at, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [id, taskId || 'unknown', customerId, reply, JSON.stringify(routesWithCtx), now, now]
  );

  console.log(`[Dispatcher] enqueue job=${id} task=${taskId} customer=${customerId} routes=${routes.length}`);
}

/**
 * 启动后台分发循环（进程启动时调用一次）
 */
export function startDispatcherLoop(): void {
  console.log(`[Dispatcher] loop started, interval=${DISPATCH_INTERVAL_MS}ms`);
  setInterval(async () => {
    try {
      await _processPendingJobs();
    } catch (err: any) {
      console.error('[Dispatcher] loop error:', err.message);
    }
  }, DISPATCH_INTERVAL_MS);
}

async function _processPendingJobs(): Promise<void> {
  const now = Date.now();

  const jobs = await db.allAsync<any>(
    `SELECT id, task_id, customer_id, reply, routes, retry_count
     FROM skill_platform.delivery_queue
     WHERE status = 'pending' AND (retry_at IS NULL OR retry_at <= $1)
     ORDER BY retry_at ASC
     LIMIT 10`,
    [now]
  );

  for (const job of jobs) {
    // 乐观锁：status = 'processing'，防止并发重复抢
    await db.runAsync(
      `UPDATE skill_platform.delivery_queue
       SET status = 'processing'
       WHERE id = $1 AND status = 'pending'`,
      [job.id]
    ).catch(() => {});

    _dispatchJob(job).catch(err =>
      console.error(`[Dispatcher] dispatchJob error job=${job.id}:`, err.message)
    );
  }
}

async function _dispatchJob(job: any): Promise<void> {
  let routes: DeliveryRoute[] = [];
  let ctx: any = {};

  try {
    const parsed = typeof job.routes === 'string' ? JSON.parse(job.routes) : job.routes;
    routes = parsed._routes || [];
    ctx    = parsed._ctx    || {};
  } catch {
    routes = [];
  }

  const reply      = job.reply;
  const retryCount = job.retry_count || 0;
  const displayName = routes[0]?.display_name || ctx.sessionId || 'unknown';

  let sent = false;

  // ① 优先 juhe 直发
  const juheRoute = routes.find((r: DeliveryRoute) => r.channel === 'juhe' && r.conv_id);
  if (juheRoute && JUHE_SEND_URL) {
    sent = await _sendViaJuhe(juheRoute.conv_id!, reply, job.id);
  }

  // ② 兜底 CUA
  if (!sent && CUA_SEND_URL) {
    sent = await _sendViaCua({
      reply,
      displayName,
      requestId: ctx.requestId || job.task_id,
      sessionId: ctx.sessionId || job.customer_id,
      status:    ctx.status    || 'done',
      reasoning: ctx.reasoning,
      delivery:  ctx.delivery,
    });
  }

  // 更新队列状态
  if (sent) {
    await db.runAsync(
      `UPDATE skill_platform.delivery_queue SET status='sent', sent_at=$1 WHERE id=$2`,
      [Date.now(), job.id]
    ).catch(() => {});
    console.log(`[Dispatcher] ✅ sent job=${job.id} customer=${job.customer_id}`);
  } else {
    const newRetryCount = retryCount + 1;
    if (newRetryCount >= MAX_RETRY) {
      await db.runAsync(
        `UPDATE skill_platform.delivery_queue SET status='dead', retry_count=$1, last_error='max retries exceeded' WHERE id=$2`,
        [newRetryCount, job.id]
      ).catch(() => {});
      console.error(`[Dispatcher] ☠️ dead job=${job.id} customer=${job.customer_id}`);
    } else {
      const nextDelay = RETRY_DELAYS_MS[newRetryCount] || 120_000;
      await db.runAsync(
        `UPDATE skill_platform.delivery_queue SET status='pending', retry_count=$1, retry_at=$2, last_error='send failed' WHERE id=$3`,
        [newRetryCount, Date.now() + nextDelay, job.id]
      ).catch(() => {});
      console.warn(`[Dispatcher] ⏳ retry job=${job.id} attempt=${newRetryCount} nextIn=${nextDelay}ms`);
    }
  }
}

async function _sendViaJuhe(conv_id: string, reply: string, jobId: string): Promise<boolean> {
  try {
    const r = await fetch(`${JUHE_SEND_URL.replace(/\/?$/, '')}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conv_id, content: reply }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      console.log(`[Dispatcher] juhe OK conv=${conv_id} job=${jobId}`);
      return true;
    }
    console.warn(`[Dispatcher] juhe HTTP ${r.status} conv=${conv_id} job=${jobId}`);
    return false;
  } catch (e: any) {
    console.warn(`[Dispatcher] juhe error: ${e.message} job=${jobId}`);
    return false;
  }
}

async function _sendViaCua(opts: {
  reply: string; displayName: string; requestId: string;
  sessionId: string; status: string; reasoning?: string; delivery?: any;
}): Promise<boolean> {
  const { reply, displayName, requestId, sessionId, status, reasoning, delivery } = opts;
  try {
    const cuaBody = {
      request_id: requestId,
      session_id: sessionId,
      status:     status === 'processing' ? 'done' : status,
      reply,
      delivery:   delivery || { app: '企业微信', recipient: displayName, action: 'type_and_send' },
      reasoning,
    };
    const r = await fetch(`${CUA_SEND_URL}/api/agent-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Secret': process.env.AGENT_SECRET || '',
      },
      body: JSON.stringify(cuaBody),
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`[Dispatcher] CUA HTTP ${r.status} recipient=${displayName}`);
    return r.ok;
  } catch (e: any) {
    console.warn(`[Dispatcher] CUA error: ${e.message}`);
    return false;
  }
}
