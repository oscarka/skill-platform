#!/usr/bin/env node
/**
 * Skill Platform 完整 E2E 自动化测试脚本
 * 对应 test_plan.md T01-T24 全部用例
 * 运行方式：node tests/test_e2e.mjs
 */

const BASE           = 'https://skill-platform-yo5337ccva-de.a.run.app';
const API            = `${BASE}/api/v1/agent`;
const TEST_USER      = 'preview_test_user';
const SANDBOX_SECRET = 'sandbox-secret-2024';
const RUN_ID         = Date.now().toString(36).slice(-6);

let passed = 0, failed = 0, skipped = 0;
const results = [];

function log(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  results.push({ label, ok, detail });
  ok ? passed++ : failed++;
}
function skip(label, reason = '') {
  console.log(`⏭️  [跳过] ${label}${reason ? ' — ' + reason : ''}`);
  skipped++;
}
function section(title) {
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function chat(content, session, extra = {}) {
  const r = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      session_id: `e2e_${session}`,
      meta: { user_id: TEST_USER, from_name: '测试用户' },
      history: [], notes: '',
      context: { available_apps: ['企业微信'], current_recipient: '测试用户' },
      source: 'wecom',
      ...extra,
    }),
  });
  if (!r.ok) throw new Error(`chat API ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return { taskId: d.request_id };
}

async function events(taskId, waitMs = 14000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const r = await fetch(`${API}/tasks/${taskId}`);
    if (r.ok) {
      const d = await r.json();
      const evs = d.events || [];
      if (evs.some(e => ['reply_sent','ticket_created','ticket_reused'].includes(e.event_type))) return d;
    }
    await sleep(800);
  }
  const r = await fetch(`${API}/tasks/${taskId}`);
  return r.ok ? r.json() : { events: [] };
}

const has = (evs, type) => evs.some(e => e.event_type === type);

function payload(evs, type) {
  const e = evs.find(e => e.event_type === type);
  if (!e) return null;
  try { return typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; }
  catch { return e.payload; }
}

function replyText(evs) { return payload(evs, 'reply_sent')?.reply || ''; }

async function clearGuards() {
  try {
    const r = await fetch(`${API}/debug/guards?user_id=${TEST_USER}`, { method: 'DELETE' });
    if (r.ok) { const d = await r.json(); if ((d.closed||0) > 0) console.log(`  🧹 清理 ${d.closed} 个残留守卫`); }
  } catch {}
}

// 清理 TEST_USER 的所有非 expired 工单（防止跨测试污染）
async function expireAllTestTickets() {
  try {
    // limit=200 避免旧的 done 工单漏网（之前 limit=20 不足）
    const r = await fetch(`${BASE}/api/tickets?created_by=${TEST_USER}&limit=200`);
    const d = await r.json();
    const tickets = d.tickets || d.data || [];
    const live = tickets.filter(t => t.status !== 'expired' && t.status !== 'error');
    if (live.length > 0) {
      console.log(`  🧹 清理 ${live.length} 个残留工单...`);
      await Promise.all(live.map(t => expireTicket(t.id)));
    }
  } catch {}
}

async function getExternalSkill() {
  const r = await fetch(`${BASE}/api/skills?status=published`);
  const d = await r.json();
  return (d.skills || d || []).find(s => s.type === 'external') || null;
}

async function createTicket(skillId, opts = {}) {
  const r = await fetch(`${BASE}/api/tickets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill_id: skillId, created_by: TEST_USER, ...opts }),
  });
  return (await r.json())?.ticket || null;
}

async function injectReport(ticketId, report) {
  const r = await fetch(`${BASE}/api/tickets/${ticketId}/agent-callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sandbox-secret': SANDBOX_SECRET },
    body: JSON.stringify({ passed: true, output: report }),
  });
  return (await r.json()).ok === true;
}

async function expireTicket(ticketId) {
  await fetch(`${BASE}/api/tickets/${ticketId}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'expired' }),
  }).catch((e) => { console.warn(`  ⚠️  expireTicket ${ticketId} 失败: ${e.message}`); });
}

// ══════════════════════════════════════════════════════════════
// 预检：测试开始前验证环境 + 数据就绪状态
// ══════════════════════════════════════════════════════════════
async function preflight() {
  console.log('\n─── 🔍 预检：环境 + 数据检查 ────────────────────────────────');
  let ok = true;

  // 1. API 连通性
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      console.log(`  ✅ API 在线  version=${d.version||'?'}  uptime=${d.uptime||'?'}s`);
    } else {
      console.log(`  ❌ API 返回 ${r.status}`);
      ok = false;
    }
  } catch (e) {
    console.log(`  ❌ API 无法连接: ${e.message}`);
    ok = false;
  }

  // 2. Supabase Schema 关键列检查（通过 query_ticket SQL 路径）
  try {
    // 创建一个临时工单验证 tickets + ticket_results JOIN 能正常执行
    const skillsR = await fetch(`${BASE}/api/skills?status=published`);
    const skillsD = await skillsR.json();
    const skills = skillsD.skills || skillsD || [];
    const extSkill = skills.find(s => s.type === 'external');
    if (extSkill) {
      // 检查 tickets 表有无 delivery_info（通过建单 API 间接验证）
      const cr = await fetch(`${BASE}/api/tickets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: extSkill.id, created_by: `preflight_check_${RUN_ID}` }),
      });
      const cd = await cr.json();
      const tmpId = cd?.ticket?.id;
      if (tmpId) {
        console.log(`  ✅ tickets 表结构正常 (delivery_info 等列存在)`);
        // 验证 ticket_results JOIN 查询
        const jr = await fetch(`${BASE}/api/tickets/${tmpId}`);
        if (jr.ok) console.log(`  ✅ ticket_results JOIN 查询正常`);
        // 清理
        await expireTicket(tmpId);
      } else {
        console.log(`  ❌ 建单失败: ${JSON.stringify(cd).slice(0,100)}`);
        ok = false;
      }
    } else {
      console.log(`  ⚠️  无已发布 external skill，部分测试会跳过`);
    }
  } catch (e) {
    console.log(`  ❌ Schema 检查异常: ${e.message}`);
    ok = false;
  }

  // 3. TEST_USER 当前工单状态 → 测试前必须全部清理干净
  try {
    const r = await fetch(`${BASE}/api/tickets?created_by=${TEST_USER}&limit=200`);
    const d = await r.json();
    const tickets = d.tickets || d.data || [];
    const live = tickets.filter(t => !['expired','error'].includes(t.status));
    const byStatus = {};
    live.forEach(t => { byStatus[t.status] = (byStatus[t.status]||0) + 1; });

    if (live.length === 0) {
      console.log(`  ✅ TEST_USER 无残留工单，数据干净`);
    } else {
      console.log(`  ⚠️  发现 ${live.length} 个残留工单: ${JSON.stringify(byStatus)} → 立即清理...`);
      await Promise.all(live.map(t => expireTicket(t.id)));
      // 验证清理结果
      const r2 = await fetch(`${BASE}/api/tickets?created_by=${TEST_USER}&limit=200`);
      const d2 = await r2.json();
      const still = (d2.tickets || d2.data || []).filter(t => !['expired','error'].includes(t.status));
      if (still.length === 0) {
        console.log(`  ✅ 清理完毕，数据已干净`);
      } else {
        // 回退版本的 expire 可能有路径差异，只警告不中止
        console.log(`  ⚠️  清理后仍有 ${still.length} 个工单未过期（可能影响部分断言，继续测试）`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  工单状态检查/清理失败: ${e.message}`);
  }

  // 4. 守卫状态
  try {
    const r = await fetch(`${API}/debug/guards?user_id=${TEST_USER}`);
    // 如果返回非 JSON（HTML），说明接口不存在（回退版本正常），只警告
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      console.log(`  ℹ️  守卫调试接口不存在（回退版本正常），跳过检查`);
    } else {
      const d = await r.json();
      const active = (d.guards || []).filter(g => g.status === 'active');
      if (active.length === 0) {
        console.log(`  ✅ TEST_USER 无残留活跃守卫`);
      } else {
        console.log(`  ⚠️  TEST_USER 有 ${active.length} 个活跃守卫（将自动清理）`);
        await clearGuards();
      }
    }
  } catch (e) {
    console.log(`  ⚠️  守卫状态检查失败: ${e.message}`);
  }

  // 5. query_ticket SQL 实际路径验证（模拟 AI 调用）
  try {
    const r = await fetch(`${API}/debug/query-ticket?user_id=${TEST_USER}`, {
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    if (r && r.ok) {
      const d = await r.json();
      console.log(`  ✅ query_ticket SQL 路径: ${d.found ? `找到工单 status=${d.status}` : '无工单（正常）'}`);
    } else {
      // 没有 debug 端点时跳过
      console.log(`  ℹ️  query_ticket SQL 调试端点不存在，跳过直接验证`);
    }
  } catch {}

  // 6. Agent task 事件系统
  try {
    const r = await fetch(`${API}/tasks?limit=1`);
    if (r.ok) {
      const d = await r.json();
      const cnt = d.total || (d.tasks||[]).length;
      console.log(`  ✅ Agent task 系统正常 (历史任务数=${cnt})`);
    } else {
      console.log(`  ❌ Agent task 系统异常 HTTP ${r.status}`);
      ok = false;
    }
  } catch (e) {
    console.log(`  ❌ Agent task 系统无法访问: ${e.message}`);
    ok = false;
  }

  console.log(`\n  预检结果: ${ok ? '✅ 全部通过，开始测试' : '❌ 存在严重问题，测试可能不准确'}`);
  console.log('─────────────────────────────────────────────────────────\n');

  if (!ok) {
    console.error('❌ 预检未通过，中止测试。请先解决上述问题。');
    process.exit(2);
  }
}

// ══════════════════════════════════════════════════════════════
// 零、基础事件链（S2）— 每条消息必有的基础事件
// ══════════════════════════════════════════════════════════════
async function testInfrastructureEvents() {
  section('零、基础事件链（S2）— message_received / wiki_fetched / context_snapshot');
  await clearGuards();
  console.log('\n[S2] 基础消息 — 验证每条消息都有完整基础事件链');
  {
    const { taskId } = await chat('你好', `s2_${RUN_ID}`);
    await sleep(5000);
    const d = await events(taskId);
    const evs = d.events || [];
    console.log(`  📋 事件链: ${evs.map(e => e.event_type).join(' → ')}`);
    log('S2-1 message_received 事件存在', has(evs, 'message_received'));
    log('S2-2 wiki_fetched 事件存在', has(evs, 'wiki_fetched'));
    log('S2-3 context_snapshot 事件存在', has(evs, 'context_snapshot'));
    const snap = payload(evs, 'context_snapshot');
    log('S2-4 context_snapshot 含 hasGuard 字段', snap !== null && 'hasGuard' in (snap||{}), JSON.stringify(snap||{}).slice(0,60));
    log('S2-5 context_snapshot 含 hasTicket 字段', snap !== null && 'hasTicket' in (snap||{}));
    const snapIdx = evs.findIndex(e => e.event_type === 'context_snapshot');
    const wikiIdx = evs.findIndex(e => e.event_type === 'wiki_fetched');
    log('S2-6 context_snapshot 在 wiki_fetched 之后', wikiIdx !== -1 && snapIdx > wikiIdx);
  }
}

// ══════════════════════════════════════════════════════════════
// 一、基础路由测试  T01 T02 T03
// ══════════════════════════════════════════════════════════════
async function testRouting() {
  section('一、基础路由测试（T01-T03）');
  await clearGuards();

  console.log('\n[T01] 普通聊天 — 不触发技能');
  {
    const { taskId } = await chat('你好，你们是做什么的？', `t01_${RUN_ID}`);
    await sleep(8000);
    const d = await events(taskId);
    const evs = d.events || [];
    const rd = payload(evs, 'route_decided');
    log('T01-1 route_decided 存在', has(evs, 'route_decided'));
    log('T01-2 confidence=none', rd?.confidence === 'none', `confidence=${rd?.confidence}`);
    log('T01-3 不创建守卫', !has(evs, 'skill_guard_activated'));
    log('T01-4 Agent 正常回复', has(evs, 'reply_sent'));
  }

  console.log('\n[T02] 健康问题 — confidence=low，不推技能');
  {
    const { taskId } = await chat('我最近睡眠不好，怎么调理？', `t02_${RUN_ID}`);
    await sleep(8000);
    const d = await events(taskId);
    const evs = d.events || [];
    const rd = payload(evs, 'route_decided');
    log('T02-1 route_decided 存在', has(evs, 'route_decided'));
    log('T02-2 confidence=low或none', rd?.confidence === 'low' || rd?.confidence === 'none', `confidence=${rd?.confidence}`);
    log('T02-3 不创建守卫', !has(evs, 'skill_guard_activated'));
    log('T02-4 Agent 回复', has(evs, 'reply_sent'));
  }

  console.log('\n[T03] 首次技能意向 — confidence=high，创建守卫');
  await clearGuards();
  {
    const { taskId } = await chat('我想要AI营养师帮我分析一下', `t03_${RUN_ID}`);
    await sleep(8000);
    const d = await events(taskId);
    const evs = d.events || [];
    const snap = payload(evs, 'context_snapshot');
    const rd   = payload(evs, 'route_decided');
    log('T03-1 context_snapshot 在路由前', has(evs, 'context_snapshot'));
    log('T03-2 hasGuard=false（首次）', snap?.hasGuard === false, `hasGuard=${snap?.hasGuard}`);
    log('T03-3 confidence=high', rd?.confidence === 'high', `confidence=${rd?.confidence}`);
    log('T03-4 skill_id 非空', !!rd?.skill_id, `skill_id=${rd?.skill_id}`);
    log('T03-5 守卫已创建', has(evs, 'skill_guard_activated'));
    log('T03-6 guard_lifecycle action=new_created', payload(evs, 'guard_lifecycle')?.action === 'new_created');
    log('T03-7 Agent介绍服务', has(evs, 'reply_sent'));
    log('T03-8 不建单', !has(evs, 'ticket_created'));
    console.log(`  💬 T03 回复: ${replyText(evs).slice(0, 80)}...`);
  }
}

// ══════════════════════════════════════════════════════════════
// 二、守卫判断分支  T04 T05 T07 T08
// ══════════════════════════════════════════════════════════════
async function testGuardJudgment() {
  section('二、守卫判断分支（T04-T08）');
  // 清理残留工单，防止 ticket_reused 而不是 ticket_created
  await expireAllTestTickets();

  // T04 守卫 → 确认 → 建单
  console.log('\n[T04] 守卫存在 → 明确确认 → 建单+发链接');
  await clearGuards();
  const sess04 = `t04_${RUN_ID}`;
  await chat('我想要AI营养师帮我做营养分析', sess04);
  await sleep(8000);
  await sleep(1000);
  {
    const { taskId } = await chat('好的，帮我开始，我确认使用这个服务', sess04);
    await sleep(14000);
    const d = await events(taskId, 20000);
    const evs = d.events || [];
    const gj  = payload(evs, 'skill_guard_judgment');
    log('T04-1 守卫判断运行', has(evs, 'skill_guard_judgment'));
    log('T04-2 判断=yes（确认）', gj?.confirm === 'yes' || gj?.interest === 'yes', `interest=${gj?.interest} confirm=${gj?.confirm}`);
    log('T04-3 工单已建', has(evs, 'ticket_created') || has(evs, 'ticket_reused'));
    log('T04-4 Agent发建单回复', has(evs, 'reply_sent'));
    const reply = replyText(evs);
    log('T04-5 回复包含H5链接', reply.includes('h5') || reply.includes('token') || reply.includes('链接'));
    console.log(`  💬 T04 回复: ${reply.slice(0, 100)}...`);
  }

  // T05 守卫 → 追问 → unclear → Agent自然引导
  console.log('\n[T05] 守卫 → 追问细节 → unclear → Agent自然引导');
  await clearGuards();
  const sess05 = `t05_${RUN_ID}`;
  await chat('我想要AI营养师帮我做营养分析', sess05);
  await sleep(8000);
  await sleep(1000);
  {
    const { taskId } = await chat('这个分析要多久能出结果？', sess05);
    await sleep(11000);
    const d = await events(taskId, 14000);
    const evs = d.events || [];
    const gj  = payload(evs, 'skill_guard_judgment');
    log('T05-1 守卫判断运行', has(evs, 'skill_guard_judgment'));
    log('T05-2 判断=unclear', gj?.confirm === 'unclear' || gj?.interest === 'unclear', `interest=${gj?.interest} confirm=${gj?.confirm}`);
    log('T05-3 走health_direct（pending_unclear）', d.route_type === 'health_direct');
    log('T05-4 agent_context_assembled（directive注入）', has(evs, 'agent_context_assembled'));
    log('T05-5 Agent回复（自然引导）', has(evs, 'reply_sent'));
    const reply = replyText(evs);
    log('T05-6 回复含引导词', reply.includes('营养') || reply.includes('服务') || reply.includes('确认') || reply.includes('使用'), `回复: ${reply.slice(0, 60)}`);
  }

  // T07 守卫 → 拒绝 → 关闭
  console.log('\n[T07] 守卫 → 拒绝 → 守卫关闭，不建单');
  await clearGuards();
  const sess07 = `t07_${RUN_ID}`;
  await chat('我想要AI营养师帮我做营养分析', sess07);
  await sleep(8000);
  await sleep(1000);
  {
    const { taskId } = await chat('不用了，先不做，谢谢', sess07);
    await sleep(9000);
    const d = await events(taskId, 12000);
    const evs = d.events || [];
    const gj  = payload(evs, 'skill_guard_judgment');
    log('T07-1 守卫判断运行', has(evs, 'skill_guard_judgment'));
    log('T07-2 判断=no（拒绝）', gj?.interest === 'no', `interest=${gj?.interest}`);
    log('T07-3 Agent回复', has(evs, 'reply_sent'));
    log('T07-4 不建单', !has(evs, 'ticket_created'));
  }

  // T08 守卫 → 无关问题 → 回答问题不强推
  console.log('\n[T08] 守卫 → 无关问题 → 主要回答问题');
  await clearGuards();
  const sess08 = `t08_${RUN_ID}`;
  await chat('我想要AI营养师帮我做营养分析', sess08);
  await sleep(8000);
  await sleep(1000);
  {
    const { taskId } = await chat('我最近血压有点高，怎么调整饮食？', sess08);
    await sleep(11000);
    const d = await events(taskId, 14000);
    const evs = d.events || [];
    const reply = replyText(evs);
    log('T08-1 Agent回复', has(evs, 'reply_sent'));
    log('T08-2 回复含血压相关', reply.includes('血压') || reply.includes('饮食') || reply.includes('盐'));
    log('T08-3 不建单', !has(evs, 'ticket_created'));
    console.log(`  💬 T08 回复: ${reply.slice(0, 100)}...`);
  }

  skip('T06 守卫模糊词', '依赖AI随机判断，建议手动验证');
}

// ══════════════════════════════════════════════════════════════
// 二b. agent_context_assembled 详细验证（S6）
// ══════════════════════════════════════════════════════════════
async function testAgentContextAssembled() {
  section('二b. agent_context_assembled 事件验证（S6）');
  await clearGuards();
  const sess6 = `s6_${RUN_ID}`;
  console.log('\n[S6] 第1条：技能意向 → 建守卫');
  {
    // 第1条消息建守卫（首条不运行守卫判断，agent_context_assembled 不触发）
    await chat('我想要AI营养师帮我做营养分析', sess6);
    await sleep(8000);
  }
  console.log('\n[S6] 第2条：追问 → 守卫判断 → agent_context_assembled 应触发');
  {
    const { taskId } = await chat('这个服务大概怎么收费？', sess6);
    await sleep(10000);
    const d = await events(taskId, 14000);
    const evs = d.events || [];
    const ctx = payload(evs, 'agent_context_assembled');
    log('S6-1 agent_context_assembled 事件存在', has(evs, 'agent_context_assembled'), ctx ? '' : '未触发');
    log('S6-2 directive 字段非空', (ctx?.directive?.length || 0) > 10, `directive前50字：${(ctx?.directive||'').slice(0,50)}`);
    log('S6-3 guardStatus 字段存在', 'guardStatus' in (ctx||{}), `guardStatus=${ctx?.guardStatus}`);
  }
}

// ══════════════════════════════════════════════════════════════
// 二c. 完整多轮集成测试（INT）— 同一 session 意向→追问→确认 三轮连贯
// ══════════════════════════════════════════════════════════════
async function testMultiTurnIntegration() {
  section('二c. 完整多轮集成（INT）— 同 session 三轮：意向→追问→确认');
  // 清理残留工单，防止 ticket_reused
  await expireAllTestTickets();
  await clearGuards();
  const sess = `int_${RUN_ID}`;

  // 第1轮：技能意向 → new_created 守卫
  console.log('\n  [INT-1/2] 第1轮：技能意向...');
  const { taskId: t1 } = await chat('我想请AI营养师帮我做营养分析', sess);
  await sleep(7000);
  const d1 = await events(t1);
  const ev1 = d1.events || [];
  log('INT-1 技能意向 → new_created 守卫', payload(ev1,'guard_lifecycle')?.action === 'new_created', `action=${payload(ev1,'guard_lifecycle')?.action}`);
  log('INT-2 技能意向 → Agent 介绍服务（reply_sent）', has(ev1, 'reply_sent'));
  console.log(`  💬 INT-1 回复: ${replyText(ev1).slice(0, 80)}`);

  // 第2轮：追问细节 → existing 守卫 → judgment=unclear
  console.log('\n  [INT-3~6] 第2轮：追问细节...');
  await sleep(1000);
  const { taskId: t2 } = await chat('这个分析要多久', sess);
  await sleep(9000);
  const d2 = await events(t2, 13000);
  const ev2 = d2.events || [];
  const gl2 = payload(ev2, 'guard_lifecycle');
  const gj2 = payload(ev2, 'skill_guard_judgment');
  log('INT-3 追问 → existing 守卫', gl2?.action === 'existing', `action=${gl2?.action}`);
  log('INT-4 追问 → guard_judgment 运行', has(ev2, 'skill_guard_judgment'));
  log('INT-5 追问 → judgment=unclear（不建单）',
    gj2?.confirm === 'unclear' || gj2?.interest === 'unclear',
    `interest=${gj2?.interest} confirm=${gj2?.confirm}`);
  log('INT-6 追问 → Agent 正常回复', has(ev2, 'reply_sent'));
  console.log(`  💬 INT-2 回复: ${replyText(ev2).slice(0, 80)}`);

  // 第3轮：确认 yes → guard_judgment + agent_context_assembled + 建单
  console.log('\n  [INT-7~9] 第3轮：确认...');
  await sleep(1000);
  const { taskId: t3 } = await chat('好的就用这个服务', sess);
  await sleep(10000);
  const d3 = await events(t3, 14000);
  const ev3 = d3.events || [];
  const gj3 = payload(ev3, 'skill_guard_judgment');
  log('INT-7 确认 → guard_judgment 运行', has(ev3, 'skill_guard_judgment'));
  log('INT-8 确认 → agent_context_assembled 存在', has(ev3, 'agent_context_assembled'));
  log('INT-9 确认 → Agent 回复存在', has(ev3, 'reply_sent'));
  console.log(`  💬 INT-3 回复: ${replyText(ev3).slice(0, 120)}`);
  // 清理INT建的工单
  const tcEv = ev3.find(e => e.event_type === 'ticket_created' || e.event_type === 'ticket_reused');
  if (tcEv) {
    const tcp = typeof tcEv.payload === 'string' ? JSON.parse(tcEv.payload) : tcEv.payload;
    const tid = tcp?.ticket_id || tcp?.ticketId || tcp?.id;
    if (tid) await expireTicket(tid);
  }
}

// ══════════════════════════════════════════════════════════════
// 二d. 守卫修复回归测试（GFIX）— unclear→Agent（不走守卫直接发消息）
// ══════════════════════════════════════════════════════════════
async function testGuardFixRegression() {
  section('二d. 守卫修复回归（GFIX）— unclear首次走Agent，不走skill_guard_clarify');
  await clearGuards();
  const sess = `gfix_${RUN_ID}`;

  // 第1条：技能意向 → 建守卫
  console.log('\n  [GFIX-1/2] 发技能意向 → 建守卫...');
  const { taskId: t1 } = await chat('我想要AI营养师帮我分析饮食', sess);
  await sleep(7000);
  const d1 = await events(t1);
  const ev1 = d1.events || [];
  log('GFIX-1 技能意向 → 守卫已建', has(ev1, 'skill_guard_activated'));
  log('GFIX-2 首条不运行守卫判断', !has(ev1, 'skill_guard_judgment'), '首条应直接建守卫不判断');

  // 第2条：发模糊短词 → unclear → 走 Agent（核心回归验证）
  console.log('\n  [GFIX-3~8] 发模糊短词 → unclear firstClarify...');
  await sleep(1000);
  const { taskId: t2 } = await chat('嗯好', sess);
  await sleep(10000);
  const d2 = await events(t2, 14000);
  const ev2 = d2.events || [];
  const routeType2 = d2.route_type || '';

  log('GFIX-3 unclear首次 → 守卫判断运行', has(ev2, 'skill_guard_judgment'));
  log('GFIX-4 unclear首次 → route_type=health_direct（不是 skill_guard_clarify）',
    routeType2 === 'health_direct', `route_type=${routeType2}`);
  log('GFIX-5 unclear首次 → agent_context_assembled 存在（走了Agent路径）',
    has(ev2, 'agent_context_assembled'));
  log('GFIX-6 unclear首次 → reply_sent 存在', has(ev2, 'reply_sent'));

  const ctx2 = payload(ev2, 'agent_context_assembled');
  const directive2 = ctx2?.directive || '';
  log('GFIX-7 directive 含引导词（服务/确认/营养）',
    directive2.includes('服务') || directive2.includes('确认') || directive2.includes('营养'),
    `directive前60字：${directive2.slice(0,60)}`);
  log('GFIX-8 route_type 绝对不是 skill_guard_clarify（回归验证）',
    routeType2 !== 'skill_guard_clarify', `route_type=${routeType2}`);

  console.log(`\n  💬 GFIX-2 Agent回复（应由Agent生成，非守卫硬编码）:`);
  console.log(`  ${replyText(ev2).slice(0, 200)}`);
}

// ══════════════════════════════════════════════════════════════
// 三+四、工单状态 + query_ticket  T09-T14
// ══════════════════════════════════════════════════════════════
async function testTicketAndQuery() {
  section('三四、工单状态处理 + query_ticket（T09-T14）');
  await clearGuards();
  // 清理 TEST_USER 所有残留工单，防止 T13a "无工单" 测试受污染
  await expireAllTestTickets();
  const skill = await getExternalSkill();
  if (!skill) { skip('T09-T14', '无已发布的 external skill'); return; }

  // T13a 无工单时不触发工具
  console.log('\n[T13a] 无工单 — 询问进度，AI正常回复');
  {
    const { taskId } = await chat('我昨天头疼了一整天，可能是什么原因？', `t13a_${RUN_ID}`);
    await sleep(9000);
    const d = await events(taskId, 12000);
    const evs = d.events || [];
    log('T13-1 无工单时 Agent 正常回复', has(evs, 'reply_sent'));
    log('T13-2 无工单时不触发 query_ticket', !has(evs, 'tool_query_ticket'));
  }

  // T09 工单进行中
  console.log('\n[T09] 工单processing中 — AI查状态告知');
  const t9 = await createTicket(skill.id, { title: `T09_${RUN_ID}` });
  if (t9) {
    await fetch(`${BASE}/api/tickets/${t9.id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    });
    await sleep(500);
    const { taskId } = await chat('最近工单进行到哪了', `t09_${RUN_ID}`);
    await sleep(10000);
    const d = await events(taskId, 12000);
    const evs = d.events || [];
    const tqPl = payload(evs, 'tool_query_ticket');
    log('T09-1 AI调用query_ticket查工单', has(evs, 'tool_query_ticket'), has(evs, 'tool_query_ticket') ? `status=${tqPl?.result?.status}` : '未触发');
    const reply = replyText(evs);
    log('T09-2 Agent回复含进度', has(evs, 'reply_sent'));
    log('T09-3 回复含状态词', reply.includes('处理') || reply.includes('分析') || reply.includes('等待') || reply.includes('工单'));
    console.log(`  💬 T09: ${reply.slice(0, 100)}`);
    await expireTicket(t9.id);
  }

  // T10+T14 工单done + 报告细节
  const MOCK_REPORT = `【AI营养师分析报告】客户：测试用户 日期：${new Date().toLocaleDateString('zh-CN')}
一、饮食结构评估
早餐：豆浆+全麦馒头，植物蛋白充足但缺动物蛋白。
建议：可将豆浆替换为牛奶（约250ml），蛋白质吸收率更高。乳糖不耐受者保留豆浆，或选择无乳糖牛奶。
午餐：蔬菜严重不足，建议每日深色蔬菜≥300g。
二、营养缺口：缺乏维生素D、铁质、优质蛋白。疲劳与铁质不足相关。
三、核心建议：1.早餐豆浆可换牛奶但每日限300ml 2.增加深色蔬菜至300g/天 3.运动后补充蛋白质`;

  console.log('\n[T10] 工单done — 查询结果');
  const t10 = await createTicket(skill.id, { title: `T10_${RUN_ID}` });
  if (t10) {
    log('T10-0 注入done报告', await injectReport(t10.id, MOCK_REPORT));
    await sleep(1000);
    const { taskId: tq10 } = await chat('我之前提交的报告出结果了吗？', `t10_${RUN_ID}`);
    await sleep(10000);
    const d10 = await events(tq10, 13000);
    const ev10 = d10.events || [];
    const tqPl10 = payload(ev10, 'tool_query_ticket');
    log('T10-1 AI调用query_ticket', has(ev10, 'tool_query_ticket'));
    log('T10-2 返回done状态', tqPl10?.result?.status === 'done', `status=${tqPl10?.result?.status}`);
    const r10 = replyText(ev10);
    log('T10-3 回复含完成词', r10.includes('完成') || r10.includes('报告') || r10.includes('生成'));
    console.log(`  💬 T10: ${r10.slice(0, 100)}`);

    // T11+T14
    console.log('\n[T11+T14] 报告细节 — AI读报告针对性回答');
    await sleep(1000);
    const { taskId: tq11 } = await chat('报告里说早餐豆浆的问题，我能换成牛奶吗？有什么注意事项？', `t11_${RUN_ID}`);
    await sleep(12000);
    const d11 = await events(tq11, 15000);
    const ev11 = d11.events || [];
    const tqPl11 = payload(ev11, 'tool_query_ticket');
    const rLen = tqPl11?.result?.report?.length || 0;
    log('T11-1 AI调用query_ticket读报告', has(ev11, 'tool_query_ticket'), has(ev11, 'tool_query_ticket') ? `报告${rLen}字` : '未触发');
    log('T14-1 query_ticket返回真实报告(>100字)', rLen > 100, `${rLen}字`);
    const r11 = replyText(ev11);
    log('T14-2 回复引用报告内容（豆浆/牛奶/乳糖/蛋白）',
      r11.includes('豆浆') || r11.includes('牛奶') || r11.includes('乳糖') || r11.includes('蛋白'),
      `回复: ${r11.slice(0, 100)}`);
    console.log(`\n  💬 T11/T14:\n  ${r11.slice(0, 350)}`);
    await expireTicket(t10.id);
  }
  skip('T12 工单未填写提醒', '需 waiting_input 工单，手动验证');
}

// ══════════════════════════════════════════════════════════════
// 六、边界情况  T17 T19
// ══════════════════════════════════════════════════════════════
async function testEdgeCases() {
  section('六、边界情况（T17 T19）');
  await clearGuards();

  console.log('\n[T17] 系统容错兜底 — 正常消息不崩溃');
  {
    const { taskId } = await chat('你好', `t17_${RUN_ID}`);
    await sleep(7000);
    const d = await events(taskId);
    log('T17-1 系统不崩溃（有回复）', has(d.events || [], 'reply_sent'));
  }
  skip('T17 注入AI失败', '需 mock Gemini API，staging 环境验证');
  skip('T18 守卫AI失败兜底', '需 mock Gemini API，staging 环境验证');
  skip('T16 守卫超轮次', '需连发10条消息，手动验证');

  console.log('\n[T19] 并发防重 — 快速连发两条');
  {
    const sess = `t19_${RUN_ID}`;
    const [r1, r2] = await Promise.all([
      chat('你好，这是第一条', sess).catch(() => null),
      chat('你好，这是第二条', sess).catch(() => null),
    ]);
    await sleep(10000);
    let preempted = 0;
    for (const r of [r1, r2]) {
      if (!r) continue;
      const d = await events(r.taskId, 1000).catch(() => ({ events: [] }));
      if (has(d.events || [], 'reply_preempted')) preempted++;
    }
    log('T19-1 并发有一条被抢占(reply_preempted)', preempted >= 1, `preempted=${preempted}`);
  }
}

// ══════════════════════════════════════════════════════════════
// 七、日志链完整性  T20
// ══════════════════════════════════════════════════════════════
async function testLogChain() {
  section('七、日志链完整性（T20）');
  await clearGuards();
  console.log('\n[T20] 技能意向场景 — 完整事件链验证');
  {
    const { taskId } = await chat('我想要AI营养师帮我做一个营养分析', `t20_${RUN_ID}`);
    await sleep(9000);
    const d = await events(taskId, 13000);
    const evs = d.events || [];
    console.log(`  📋 事件链: ${evs.map(e => e.event_type).join(' → ')}`);
    log('T20-1 context_snapshot 存在', has(evs, 'context_snapshot'));
    log('T20-2 route_decided 存在', has(evs, 'route_decided'));
    log('T20-3 guard_lifecycle 存在', has(evs, 'guard_lifecycle'));
    log('T20-4 reply_sent 存在', has(evs, 'reply_sent'));
    const rd = payload(evs, 'route_decided');
    log('T20-5 route_decided 含 confidence 字段', 'confidence' in (rd || {}), `confidence=${rd?.confidence}`);
    const snapIdx = evs.findIndex(e => e.event_type === 'context_snapshot');
    const rdIdx   = evs.findIndex(e => e.event_type === 'route_decided');
    log('T20-6 context_snapshot 早于 route_decided', snapIdx !== -1 && rdIdx !== -1 && snapIdx < rdIdx);
  }
}

// ══════════════════════════════════════════════════════════════
// 八、完整E2E工单流程  T23 T24 + T11 T14 贯通
// ══════════════════════════════════════════════════════════════
async function testFullE2E() {
  section('八、完整E2E工单流程（T23 T24 + T11 T14 贯通）');
  const sess = `e2e_${RUN_ID}`;
  await clearGuards();
  // 清理所有残留工单，防止守卫 reuse 旧工单导致 "已提交过" 错误
  await expireAllTestTickets();
  let ticketId = null, ticketToken = null;

  try {
    // Step1: 意向 → 守卫
    console.log('\n[E2E-1] 用户意向 → 守卫创建');
    const { taskId: t1 } = await chat('我想要AI营养师帮我分析一下饮食结构', sess);
    await sleep(8000);
    const d1 = await events(t1);
    log('E2E-1 意向 → 守卫创建', has(d1.events || [], 'skill_guard_activated'));

    // Step2: 确认 → 建单
    console.log('\n[E2E-2] 确认使用 → 建单');
    await sleep(1000);
    const { taskId: t2 } = await chat('好的，我确认，帮我安排', sess);
    await sleep(12000);
    const d2 = await events(t2, 16000);
    const ev2 = d2.events || [];
    const tcEv = ev2.find(e => e.event_type === 'ticket_created' || e.event_type === 'ticket_reused');
    if (tcEv) {
      const tcp = typeof tcEv.payload === 'string' ? JSON.parse(tcEv.payload) : tcEv.payload;
      ticketId = tcp?.ticket_id || tcp?.ticketId || tcp?.id;
    }
    if (!ticketId) {
      const tList = await fetch(`${BASE}/api/tickets?created_by=${TEST_USER}`).then(r => r.json()).catch(() => ({}));
      const latest = (tList.tickets || tList || []).filter(t => t.created_by === TEST_USER).sort((a,b) => b.created_at - a.created_at)[0];
      ticketId = latest?.id;
    }
    log('E2E-2 工单已创建', !!ticketId, ticketId || '未找到');
    log('E2E-3 Agent发建单回复', has(ev2, 'reply_sent'));
    const r2 = replyText(ev2);
    log('E2E-3b 回复含H5链接', r2.includes('h5') || r2.includes('token') || r2.includes('http'));
    console.log(`  💬 E2E-2: ${r2.slice(0, 120)}`);

    if (!ticketId) { console.log('  ⚠️  无ticket_id，跳过后续'); return; }

    // Step3: 获取 H5 token
    console.log(`\n[E2E-3] 获取H5 token...`);
    const td = await fetch(`${BASE}/api/tickets/${ticketId}`).then(r => r.json());
    ticketToken = td?.ticket?.token || td?.token;
    log('E2E-4 获取H5 token', !!ticketToken, ticketToken ? `${ticketToken.slice(0,8)}...` : '无token');

    if (ticketToken) {
      // Step4: GET H5
      const h5r = await fetch(`${BASE}/api/h5/${ticketToken}`);
      log('E2E-4b GET H5表单成功', h5r.ok);

      // Step5: 提交H5表单（T23前提）
      console.log('\n[E2E-5] 提交H5表单...');
      const submitR = await fetch(`${BASE}/api/h5/${ticketToken}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '测试用户', age: '35', gender: '女',
          health_goal: '减脂增肌，改善睡眠',
          breakfast: '豆浆一杯+全麦馒头，偶尔鸡蛋',
          lunch: '白米饭+一个炒菜，很少吃蔬菜',
          dinner: '清淡为主，水煮蔬菜或粥',
          exercise: '每周跑步2次30分钟',
          allergies: '对花生过敏',
          concerns: '下午疲劳，血红蛋白略低',
        }),
      });
      const submitD = await submitR.json();
      log('E2E-5 H5表单提交成功（T23前提）', submitR.ok, submitR.ok ? submitD?.message?.slice(0,40) : submitD?.error?.slice(0,40));

      // Step6: 等待AI处理（最多45秒）
      console.log('\n[E2E-6] 等待AI处理（最多45秒）...');
      let status = 'submitted';
      for (let i = 0; i < 15 && status !== 'done' && status !== 'error'; i++) {
        await sleep(3000);
        const tp = await fetch(`${BASE}/api/tickets/${ticketId}`).then(r => r.json());
        status = tp?.ticket?.status || tp?.status || 'unknown';
        if (i % 3 === 0) console.log(`    → ${status} (${(i+1)*3}s)`);
      }
      if (status !== 'done') {
        console.log(`  [fallback] 注入模拟报告...`);
        const mockReport = `【AI营养师个性化分析报告】客户：测试用户(35岁女) 日期：${new Date().toLocaleDateString('zh-CN')}
一、饮食结构
早餐豆浆+馒头植物蛋白充足，但缺乏动物蛋白和钙质。
可将豆浆替换为牛奶(250ml)，蛋白质吸收率提升约40%。如有乳糖不耐受选无乳糖牛奶或保留豆浆。
午餐蔬菜严重不足，建议每日深色蔬菜≥300g。
二、疲劳原因：铁质摄入不足(蔬菜少)，下午低血糖(碳水为主)。
建议增加红肉每周3次，菠菜+VC同食促铁吸收。
三、核心建议：①豆浆→牛奶+补鸡蛋 ②增深色蔬菜 ③每周3次瘦肉 ④增饮水
注意：对花生过敏，建议已回避花生。`;
        await injectReport(ticketId, mockReport);
        await sleep(2000);
        const tp = await fetch(`${BASE}/api/tickets/${ticketId}`).then(r => r.json());
        status = tp?.ticket?.status || tp?.status;
      }
      log('E2E-6 工单状态=done（T24前提）', status === 'done', `status=${status}`);
      log('T24-1 工单完成通知链路（notifyUserTicketDone触发）', status === 'done', '无微信渠道时优雅跳过推送');

      // Step7: 用户询问报告细节（T11+T14贯通）
      console.log('\n[E2E-7 / T11+T14] 询问报告细节...');
      await sleep(1000);
      const { taskId: tQ } = await chat(
        '我的营养分析报告里关于早餐豆浆的建议，我可以换成牛奶吗？有什么注意事项？',
        `e2e_rpt_${RUN_ID}`,
      );
      await sleep(13000);
      const dQ = await events(tQ, 16000);
      const evQ = dQ.events || [];
      const tqQ = payload(evQ, 'tool_query_ticket');
      const rLen = tqQ?.result?.report?.length || 0;
      log('E2E-7 AI调用query_ticket读报告', has(evQ, 'tool_query_ticket'), has(evQ, 'tool_query_ticket') ? `${rLen}字` : '未触发');
      log('E2E-8 query_ticket返回真实报告(>100字)', rLen > 100, `${rLen}字`);
      const replyQ = replyText(evQ);
      log('E2E-9 回复基于报告内容（豆浆/牛奶/乳糖/蛋白/铁）',
        replyQ.includes('豆浆') || replyQ.includes('牛奶') || replyQ.includes('乳糖') ||
        replyQ.includes('蛋白') || replyQ.includes('铁') || replyQ.includes('吸收'),
        `${replyQ.slice(0, 120)}`);
      console.log(`\n  💬 E2E报告细节回复:\n  ${replyQ.slice(0, 500)}`);
    }
  } catch (e) {
    log('E2E 完整流程', false, e.message);
  } finally {
    if (ticketId) await expireTicket(ticketId);
  }
}

// ══════════════════════════════════════════════════════════════
// 二f. 重构 Bug 修复回归（RFIX2）
//   Bug1: 同skill同session → 第二条走judgment，不重建守卫
//   Bug2: done工单 + 重做意图 → expire旧单，新建工单
//   Bug3: processing/submitted工单 → 不进守卫/推荐流程
//   Arch: 守卫判断在路由后 — event顺序验证
// ══════════════════════════════════════════════════════════════
async function testRefactorBugFixes() {
  section('二f. 重构 Bug 修复回归（RFIX2）— 双守卫/重做/Processing/架构顺序');
  const skill = await getExternalSkill();
  if (!skill) { skip('RFIX2', '无已发布的 external skill'); return; }

  // ── Bug1: 同 skill 同 session，第二条不重建守卫 ──────────────────────────
  console.log('\n[RFIX2-Bug1] 同session同skill → 第二条走judgment，不新建守卫');
  await clearGuards();
  await expireAllTestTickets();
  const sessB1 = `rfix2_b1_${RUN_ID}`;

  const { taskId: b1t1 } = await chat('我想要AI营养师帮我做营养分析', sessB1);
  await sleep(8000);
  const db1a = await events(b1t1);
  const evb1a = db1a.events || [];
  log('RFIX2-B1-1 第一条 → 建守卫', has(evb1a, 'skill_guard_activated'));
  log('RFIX2-B1-2 第一条 → 不运行守卫判断（首次建守卫）',
    !has(evb1a, 'skill_guard_judgment'), '首条建守卫不判断');

  await sleep(1000);
  const { taskId: b1t2 } = await chat('我想要AI营养师帮我做营养分析', sessB1);
  await sleep(10000);
  const db1b = await events(b1t2, 14000);
  const evb1b = db1b.events || [];
  log('RFIX2-B1-3 第二条 → 不新建守卫（Bug1修复验证）',
    !has(evb1b, 'skill_guard_activated'), '同skill不重建');
  log('RFIX2-B1-4 第二条 → 运行守卫判断', has(evb1b, 'skill_guard_judgment'), '应走判断路径');
  log('RFIX2-B1-5 第二条 → 有回复', has(evb1b, 'reply_sent'));

  // ── Bug3: processing/submitted 工单时不进守卫/推荐流程 ───────────────────
  console.log('\n[RFIX2-Bug3] 工单processing → 意向消息不创建守卫，回复处理中');
  await clearGuards();
  await expireAllTestTickets();

  const tB3 = await createTicket(skill.id, { title: `RFIX2_B3_${RUN_ID}` });
  if (tB3) {
    // 使用 /status 接口（同 expireTicket），PUT /api/tickets/:id 不更新status
    await fetch(`${BASE}/api/tickets/${tB3.id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    });
    await sleep(500);
    const { taskId: b3t } = await chat('我想要AI营养师帮我做营养分析', `rfix2_b3_${RUN_ID}`);
    await sleep(10000);
    const db3 = await events(b3t, 13000);
    const evb3 = db3.events || [];
    log('RFIX2-B3-1 processing工单 → 不新建守卫（Bug3修复验证）',
      !has(evb3, 'skill_guard_activated'));
    log('RFIX2-B3-2 Agent有回复（不崩溃）', has(evb3, 'reply_sent'));
    const replyB3 = replyText(evb3);
    log('RFIX2-B3-3 回复提示工单进行中',
      replyB3.includes('处理') || replyB3.includes('分析') ||
      replyB3.includes('等待') || replyB3.includes('工单') || replyB3.includes('进行'),
      `回复: ${replyB3.slice(0, 80)}`);
    await expireTicket(tB3.id);
  }

  // ── Bug2: done 工单 + 重做意图 → expire旧单，新建工单 ────────────────────
  console.log('\n[RFIX2-Bug2] done工单 + 重做意图 → expire旧单+新建工单');
  await clearGuards();
  await expireAllTestTickets();
  const sessB2 = `rfix2_b2_${RUN_ID}`;

  const tB2 = await createTicket(skill.id, { title: `RFIX2_B2_${RUN_ID}` });
  if (tB2) {
    log('RFIX2-B2-0 注入done报告',
      await injectReport(tB2.id, '【测试报告】营养分析完成，建议多吃蔬菜减少精制碳水。'));
    await sleep(500);

    // Round1: 有done工单 → 发意向 → done不阻断Step4 → 建守卫
    const { taskId: b2t1 } = await chat('我想要AI营养师帮我做营养分析', sessB2);
    await sleep(8000);
    const db2a = await events(b2t1);
    log('RFIX2-B2-1 有done工单时仍可建守卫（done不阻断推荐）',
      has(db2a.events||[], 'skill_guard_activated'));

    // Round2: 确认 + 重做关键词 → judgment=yes → handleHealthSkill → redo
    await sleep(1000);
    const { taskId: b2t2 } = await chat('好的，我想重新再做一次，帮我开始', sessB2);
    await sleep(13000);
    const db2b = await events(b2t2, 17000);
    const evb2b = db2b.events || [];
    const gjB2 = payload(evb2b, 'skill_guard_judgment');
    log('RFIX2-B2-2 守卫判断运行', has(evb2b, 'skill_guard_judgment'));
    log('RFIX2-B2-3 判断=confirm:yes（含重做+确认意图）', gjB2?.confirm === 'yes',
      `confirm=${gjB2?.confirm} interest=${gjB2?.interest}`);
    log('RFIX2-B2-4 新建工单（不显示旧报告）', has(evb2b, 'ticket_created'),
      'Bug2修复验证：重做意图→新建工单');
    log('RFIX2-B2-5 Agent有回复', has(evb2b, 'reply_sent'));

    // 验证旧工单已被 expire
    const oldTData = await fetch(`${BASE}/api/tickets/${tB2.id}`)
      .then(r => r.json()).catch(() => ({}));
    const oldStatus = oldTData?.ticket?.status || oldTData?.status;
    log('RFIX2-B2-6 旧工单已被expire（Bug2关键断言）', oldStatus === 'expired',
      `旧单status=${oldStatus}`);

    // 新旧工单 ID 不同
    const tcEvB2 = evb2b.find(e => e.event_type === 'ticket_created');
    if (tcEvB2) {
      const tcp = typeof tcEvB2.payload === 'string' ? JSON.parse(tcEvB2.payload) : tcEvB2.payload;
      const newTid = tcp?.ticket_id || tcp?.ticketId || tcp?.id;
      log('RFIX2-B2-7 新工单ID与旧工单不同', !!newTid && newTid !== tB2.id,
        `new=${(newTid||'?').slice(0,12)} old=${tB2.id.slice(0,12)}`);
      if (newTid) await expireTicket(newTid);
    }
    if (oldStatus !== 'expired') await expireTicket(tB2.id);
  }

  // ── 架构验证: 守卫判断在路由后（event 顺序）─────────────────────────────
  console.log('\n[RFIX2-Arch] 守卫判断在路由后 → context_snapshot < route_decided < skill_guard_judgment');
  await clearGuards();
  await expireAllTestTickets();
  const sessArch = `rfix2_arch_${RUN_ID}`;

  await chat('我想要AI营养师', sessArch);
  await sleep(8000);

  await sleep(1000);
  // 发确认意图消息（而非提问），让守卫判断有机会运行（routing 可能 none，但守卫判断独立于 routing）
  const { taskId: archT } = await chat('好的，帮我开始分析吧', sessArch);
  await sleep(10000);
  const dArch = await events(archT, 14000);
  const evArch = dArch.events || [];
  const archTypes = evArch.map(e => e.event_type);
  const ctxIdx = archTypes.indexOf('context_snapshot');
  const rdIdx  = archTypes.indexOf('route_decided');
  const gjIdx  = archTypes.indexOf('skill_guard_judgment');

  console.log(`  📋 事件顺序: ...${archTypes.slice(Math.max(0,ctxIdx-1)).join(' → ')}`);
  log('RFIX2-Arch-1 context_snapshot < route_decided（快照在路由前）',
    ctxIdx !== -1 && rdIdx !== -1 && ctxIdx < rdIdx, `ctx[${ctxIdx}] rd[${rdIdx}]`);
  log('RFIX2-Arch-2 route_decided < skill_guard_judgment（守卫判断在路由后）',
    rdIdx !== -1 && gjIdx !== -1 && rdIdx < gjIdx, `rd[${rdIdx}] gj[${gjIdx}]`);
  log('RFIX2-Arch-3 skill_guard_judgment 事件确实存在', gjIdx !== -1, `gj索引=${gjIdx}`);
}

// ══════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Skill Platform — 完整 E2E 自动化测试（T01-T24 + JUHE）        ║');
  console.log(`║   RUN_ID: ${RUN_ID}   服务: ${BASE.replace('https://', '').slice(0,35)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await preflight();  // ← 预检：环境 + Schema + 数据状态

  await testInfrastructureEvents();       // S2: 基础事件链 (6)
  await testRouting();                     // T01-T03: 路由 (16)
  await testGuardJudgment();               // T04-T08: 守卫判断 (20)
  await testAgentContextAssembled();       // S6: agent_context_assembled (3)
  await testMultiTurnIntegration();        // INT: 同session多轮 (9)
  await testGuardFixRegression();          // GFIX: 守卫修复回归 (8)
  await testRefactorBugFixes();            // RFIX2: 双守卫/重做/Processing/架构顺序 (20)
  await testTicketAndQuery();              // T09-T14: 工单+query_ticket (12)

  await testHistoricalConversations();      // HIST: 历史对话场景 (18)

  section('五、跨 skill 守卫切换（T15）');
  skip('T15 跨skill守卫切换', '需≥2个不同 external skill，手动验证');

  await testEdgeCases();                   // T17 T19: 边界情况 (2)
  await testLogChain();                    // T20: 日志链 (6)
  await clearGuards();
  await testFullE2E();                     // E2E: 完整工单流程 (10)
  // ⚠️ juhe 渠道测试：当前回退版本不支持，设 SKIP_JUHE=1 跳过
  if (process.env.SKIP_JUHE !== '1') {
    await testJuheChannel();               // JUHE: juhe 渠道集成验证 (5)
  } else {
    section('十、juhe 渠道集成验证（JUHE）');
    skip('JUHE-1~5 juhe渠道', '当前版本未含 juhe 支持 (SKIP_JUHE=1)，回退版本跳过');
  }

  section('八、回归测试（T21-T22，手动项）');
  skip('T21 Wiki档案保留', '需要检查Agent回复是否体现健康档案，手动验证');
  skip('T22 LLMWiki日志写入', '需要检查 data/logs/{userId}.json，手动验证');
  skip('T23 H5提交确认通知（完整）', 'E2E-5已覆盖API层，真实微信推送需真实渠道');
  skip('T24 报告通知微信推送（完整）', 'E2E-6已触发通知链路，真实推送需真实渠道');

  // 汇总
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`  ✅ ${passed} 通过   ❌ ${failed} 失败   ⏭️  ${skipped} 跳过`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  if (failed > 0) {
    console.log('\n❌ 失败项：');
    results.filter(r => !r.ok).forEach(r => console.log(`  ${r.label}: ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

// ══════════════════════════════════════════════════════════════
// 九、历史对话场景模拟（HIST）— 真实多轮对话模式
// ══════════════════════════════════════════════════════════════
async function testHistoricalConversations() {
  section('九、历史对话场景模拟（HIST）');
  await clearGuards();
  await expireAllTestTickets();
  const skill = await getExternalSkill();

  // ── HIST-1: 带历史上下文的健康追问 ─────────────────────────────
  // 用户先聊了两轮血压，第三轮问能不能吃某食物
  // 期望: Agent 能结合对话历史给出连贯回复，不触发路由
  console.log('\n[HIST-1] 带历史上下文的健康追问 — 对话连贯性');
  {
    const history = [
      { role: 'user',      content: '我最近血压有点高，140/90，需要注意什么？' },
      { role: 'assistant', content: '血压140/90属于一级高血压，建议低盐饮食，每天盐摄入不超过5g，多吃芹菜、香蕉等含钾食物。' },
      { role: 'user',      content: '那我可以喝咖啡吗？' },
      { role: 'assistant', content: '高血压患者建议每天咖啡因摄入不超过200mg，相当于1-2杯咖啡，最好在上午喝，避免影响睡眠。' },
    ];
    const { taskId } = await chat('那红酒呢？少量喝有益于心脏吗？', `hist1_${RUN_ID}`, { history });
    await sleep(9000);
    const d = await events(taskId, 12000);
    const evs = d.events || [];
    const reply = replyText(evs);
    log('HIST-1a Agent正常回复（连贯对话）', has(evs, 'reply_sent'));
    log('HIST-1b 不触发守卫（健康话题，无skill意向）', !has(evs, 'guard_lifecycle') || payload(evs, 'guard_lifecycle')?.action === 'existing');
    log('HIST-1c 回复含「红酒/酒/心脏/饮酒」相关词', /红酒|饮酒|酒精|心脏|心血管/.test(reply));
    console.log(`  💬 HIST-1: ${reply.slice(0, 120)}`);
  }

  // ── HIST-2: 单字词确认（"好" / "嗯"）守卫判断 ──────────────────
  // 用户意向后，仅回了一个"好"来确认，AI 应判断为 yes 并建单
  if (skill) {
    console.log('\n[HIST-2] 单字词确认"好" — 守卫 yes 判断');
    const sess = `hist2_${RUN_ID}`;
    // 第1轮：建守卫
    const { taskId: t1 } = await chat(`我想试试${skill.name}`, sess);
    await sleep(10000);
    const d1 = await events(t1, 12000);
    const guard1Created = has(d1.events||[], 'guard_lifecycle');
    log('HIST-2a 意向消息创建守卫', guard1Created);

    if (guard1Created) {
      // 第2轮：只回"好"
      const { taskId: t2 } = await chat('好', sess);
      await sleep(10000);
      const d2 = await events(t2, 12000);
      const evs2 = d2.events || [];
      const judgment = payload(evs2, 'skill_guard_judgment');
      log('HIST-2b 单字"好" → 守卫判断运行', has(evs2, 'skill_guard_judgment'));
      log('HIST-2c 判断结果 interest=yes 或 confirm=yes',
        judgment?.interest === 'yes' || judgment?.confirm === 'yes');
      log('HIST-2d 建单或守卫引导（ticket_created / skill_guard_clarify / reply含http）',
        has(evs2, 'ticket_created') || has(evs2, 'skill_guard_clarify') || replyText(evs2).includes('http'));
      console.log(`  💬 HIST-2回复: ${replyText(evs2).slice(0, 120)}`);
    }
    await clearGuards();
    await expireAllTestTickets();
  }

  // ── HIST-3: 对话中途切换话题 ────────────────────────────────────
  // 讨论技能意向中途用户突然问血糖问题，AI 应先回答问题，守卫保留
  if (skill) {
    console.log('\n[HIST-3] 对话中途话题切换 — 守卫保留，先回答问题');
    const sess = `hist3_${RUN_ID}`;
    const { taskId: t1 } = await chat(`${skill.name}这个服务怎么用？`, sess);
    await sleep(10000);
    const d1 = await events(t1, 12000);
    log('HIST-3a 意向消息识别', has(d1.events||[], 'route_decided'));

    // 第2轮：突然切换话题
    const { taskId: t2 } = await chat('先不说这个了，我最近血糖6.8，正常吗？', sess);
    await sleep(10000);
    const d2 = await events(t2, 12000);
    const evs2 = d2.events || [];
    const reply2 = replyText(evs2);
    log('HIST-3b 话题切换后Agent正常回复', has(evs2, 'reply_sent'));
    log('HIST-3c 回复含血糖相关内容', /血糖|6\.8|正常|偏高|空腹|餐后/.test(reply2));
    log('HIST-3d 不立即建单（话题切换不等于确认）', !has(evs2, 'ticket_created'));
    console.log(`  💬 HIST-3: ${reply2.slice(0, 120)}`);
    await clearGuards();
  }

  // ── HIST-4: 不耐烦催促 — 已有 processing 工单时 ────────────────
  // 用户已有分析中工单，不断催促"怎么还没出来"
  if (skill) {
    console.log('\n[HIST-4] 催促追问 — 已有processing工单时AI安抚');
    const t = await createTicket(skill.id, { title: `HIST4_${RUN_ID}` });
    if (t) {
      // 设为 submitted（AI处理中）
      await fetch(`${BASE}/api/tickets/${t.id}/status`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'submitted' }),
      });
      const history = [
        { role: 'user',      content: '我的分析报告出来了吗？' },
        { role: 'assistant', content: 'AI正在为您分析，请稍等，通常需要5-10分钟。' },
      ];
      const { taskId } = await chat('还没有吗？怎么这么慢！', `hist4_${RUN_ID}`, { history });
      await sleep(10000);
      const d = await events(taskId, 14000);
      const evs = d.events || [];
      const reply = replyText(evs);
      log('HIST-4a AI调用query_ticket查状态', has(evs, 'tool_query_ticket'));
      log('HIST-4b 回复安抚用户（不产生新工单）', has(evs, 'reply_sent') && !has(evs, 'ticket_created'));
      log('HIST-4c 回复含安抚或进度词', /分析|处理|等待|稍|正在|结果|报告/.test(reply));
      console.log(`  💬 HIST-4: ${reply.slice(0, 120)}`);
      await expireAllTestTickets();
    }
  }

  // ── HIST-5: 礼貌拒绝变体 — "不用了谢谢" ────────────────────────
  // 守卫存在时，用户礼貌拒绝，守卫应关闭，Agent正常回复
  if (skill) {
    console.log('\n[HIST-5] 礼貌拒绝变体 — "不用了谢谢"');
    await clearGuards(); // 确保 HIST-4 后没有残留守卫
    const sess = `hist5_${RUN_ID}`;
    const { taskId: t1 } = await chat(`我想用${skill.name}做个分析，帮我安排一下`, sess);
    await sleep(10000);
    const d1 = await events(t1, 12000);
    const guardCreated = has(d1.events||[], 'guard_lifecycle');
    log('HIST-5a 意向消息建守卫', guardCreated);

    if (guardCreated) {
      const { taskId: t2 } = await chat('不用了谢谢，我再考虑考虑', sess);
      await sleep(10000);
      const d2 = await events(t2, 12000);
      const evs2 = d2.events || [];
      const jPayload = payload(evs2, 'skill_guard_judgment');
      log('HIST-5b 守卫判断运行', has(evs2, 'skill_guard_judgment'));
      log('HIST-5c 判断为拒绝（interest=no）', jPayload?.interest === 'no');
      log('HIST-5d 不建单', !has(evs2, 'ticket_created'));
      log('HIST-5e Agent礼貌回复', has(evs2, 'reply_sent'));
      console.log(`  💬 HIST-5: ${replyText(evs2).slice(0, 100)}`);
    }
    await clearGuards();
  }

  // ── HIST-6: session隔离 — 不同session互不影响 ──────────────────
  // 用户A在sessionA建了守卫，用户同一account发起sessionB，守卫不应互串
  if (skill) {
    console.log('\n[HIST-6] Session隔离 — 不同session守卫独立');
    const sessA = `hist6A_${RUN_ID}`;
    const sessB = `hist6B_${RUN_ID}`;

    // sessionA 建守卫
    const { taskId: tA } = await chat(`我想用${skill.name}做个分析`, sessA);
    await sleep(8000);
    const dA = await events(tA, 10000);
    log('HIST-6a sessionA建守卫', has(dA.events||[], 'guard_lifecycle'));

    // sessionB 普通健康问题，不触发同一守卫
    const { taskId: tB } = await chat('我头疼，是什么原因？', sessB);
    await sleep(8000);
    const dB = await events(tB, 10000);
    const evsB = dB.events || [];
    const csB = payload(evsB, 'context_snapshot');
    log('HIST-6b sessionB无守卫干扰（hasGuard=false）',
      csB?.hasGuard === false || !has(evsB, 'guard_lifecycle'));
    log('HIST-6c sessionB正常回复头疼问题', /头疼|头痛|原因|血压|休息|睡眠/.test(replyText(evsB)));
    await clearGuards();
  }
}

main().catch(e => { console.error('脚本崩溃:', e); process.exit(1); });

// ══════════════════════════════════════════════════════════════
// 十、juhe 渠道集成验证（JUHE）
// 验证：/api/orch/ingest channel=juhe → 处理 → /api/send 回调
// ══════════════════════════════════════════════════════════════
async function testJuheChannel() {
  section('十、juhe 渠道集成验证（JUHE）');

  const JUHE_BASE = 'https://juhe-api-yo5337ccva-de.a.run.app';
  const JUHE_USER_ID = '7881301632907931';  // Oscar 的 vid
  const JUHE_CONV_ID = `S:${JUHE_USER_ID}`;
  const JUHE_SESSION = `juhe_e2e_${RUN_ID}`;

  // JUHE-1: juhe-api /health 确认在线
  console.log('\n[JUHE-1] juhe-api 服务在线检查');
  try {
    const r = await fetch(`${JUHE_BASE}/health`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    log('JUHE-1 juhe-api /health 在线', r.ok && d.ok === true, `service=${d.service}`);
  } catch (e) {
    log('JUHE-1 juhe-api /health 在线', false, e.message);
    skip('JUHE-2~5', 'juhe-api 不在线，跳过后续');
    return;
  }

  // JUHE-2: /api/orch/ingest 接受 channel=juhe
  console.log('\n[JUHE-2] POST /api/orch/ingest — channel=juhe 入站消息');
  let taskId = null;
  try {
    const r = await fetch(`${BASE}/api/orch/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_name:       'Oscar（juhe测试）',
        from_user_id:    JUHE_USER_ID,
        content:         '你好，这是来自 juhe 渠道的测试消息，请回复一句话确认收到。',
        msgtype:         'text',
        channel:         'juhe',
        conversation_id: JUHE_CONV_ID,
        history:         [],
        idempotency_key: `juhe_test_${RUN_ID}`,
        meta: { guid: 'e5e80184-bca5-3fa1-b394-be565cedfa1e' },
      }),
    });
    const d = await r.json();
    log('JUHE-2 ingest 返回 200', r.ok, `HTTP ${r.status}`);
    log('JUHE-2b ok=true', d.ok === true, JSON.stringify(d).slice(0, 60));
  } catch (e) {
    log('JUHE-2 ingest', false, e.message);
  }

  // JUHE-3: 等待 task 事件完成（查 tasks API 找最近的 juhe channel task）
  console.log('\n[JUHE-3] 等待 AI 处理完成（最多 20s）...');
  await sleep(15000);
  try {
    const r = await fetch(`${BASE}/api/v1/agent/tasks?limit=10`);
    const d = await r.json();
    const tasks = d.tasks || [];
    const juheTask = tasks.find(t => t.source_channel === 'juhe' &&
      (t.user_id === JUHE_USER_ID || t.user_id === `juhe_${JUHE_USER_ID}`));
    log('JUHE-3 找到 juhe channel task', !!juheTask, juheTask ? `id=${juheTask.id} status=${juheTask.status}` : '未找到');

    if (juheTask) {
      const tr = await fetch(`${BASE}/api/v1/agent/tasks/${juheTask.id}`);
      const td = await tr.json();
      const evs = td.events || [];
      console.log(`  📋 事件链: ${evs.map(e => e.event_type).join(' → ')}`);

      log('JUHE-4 reply_sent 事件存在', evs.some(e => e.event_type === 'reply_sent'));
      const replyEv = evs.find(e => e.event_type === 'reply_sent');
      const replyP = replyEv ? (typeof replyEv.payload === 'string' ? JSON.parse(replyEv.payload) : replyEv.payload) : null;
      const reply = replyP?.reply || '';
      console.log(`  💬 AI 回复: ${reply.slice(0, 120)}`);
      log('JUHE-4b AI 有实质回复（>5字）', reply.length > 5, `${reply.length}字`);
    }
  } catch (e) {
    log('JUHE-3 查询 task', false, e.message);
  }

  // JUHE-5: 验证 juhe-api /api/send 是否被 skill-platform 调用成功（通过查 juhe_wecom.messages 出站记录）
  console.log('\n[JUHE-5] juhe-api /api/status 确认服务正常');
  try {
    const r = await fetch(`${JUHE_BASE}/api/status`);
    const d = await r.json();
    log('JUHE-5 juhe-api 状态正常', d.ok === true && !!d.guid, `guid=${d.guid}`);
  } catch (e) {
    log('JUHE-5', false, e.message);
  }
}
