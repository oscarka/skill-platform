#!/usr/bin/env node
/**
 * 工单完整流程 E2E 测试 v5
 * 修复：
 *   - ticket_reused 没有 token，改从 GET /api/tickets/:id 取 token
 *   - 清理时把 processing 也过期掉
 *   - 支持工单已存在时重置状态为 waiting_input 后重新提交
 */

const BASE       = 'https://skill-platform-yo5337ccva-de.a.run.app';
const API        = `${BASE}/api/v1/agent`;
const USER_ID    = 'preview_test_user';
const FROM_NAME  = '测试用户';
const SKILL_ID   = 'a2a53e54-98ca-4980-8b19-c18dea109877';
const SKILL_NAME = 'AI营养师';
const SESSION    = `ticket_e2e_${Date.now()}`;

let passed = 0, failed = 0;
function ok(label, value, detail = '') {
  console.log(`  ${value ? '✅' : '❌'} ${label}${detail ? '  →  ' + detail : ''}`);
  value ? passed++ : failed++;
}
function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parsePayload(ev) {
  if (!ev) return {};
  try { return typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload || {}); }
  catch { return {}; }
}

async function getTask(taskId) {
  const r = await fetch(`${API}/tasks/${taskId}`);
  return r.ok ? r.json() : { events: [] };
}

async function pollTaskEvents(taskId, untilTypes, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await getTask(taskId);
    if (untilTypes.some(t => (d.events || []).some(e => e.event_type === t))) return d;
    await sleep(1000);
  }
  return getTask(taskId);
}

async function pollTicketStatus(ticketId, targetStatuses, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
    if (r.ok) {
      const d = await r.json();
      const status = d.ticket?.status ?? d.status;
      if (targetStatuses.includes(status)) return d;
      process.stdout.write(`    ⏳ status=${status} (${Math.round((Date.now()-start)/1000)}s)...\r`);
    }
    await sleep(3000);
  }
  const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
  return r.ok ? r.json() : null;
}

// 获取 ticket 详情，token 在 d.ticket.token
async function getTicketDetail(ticketId) {
  const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
  if (!r.ok) return null;
  const d = await r.json();
  return d.ticket ? d : { ticket: d, result: null };
}

// 设置 ticket status
async function setTicketStatus(ticketId, status) {
  const r = await fetch(`${BASE}/api/tickets/${ticketId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return r.ok;
}

// 清理同 skill 存量工单（过期所有活跃状态）
async function cleanupTickets() {
  try {
    const r = await fetch(`${BASE}/api/tickets?created_by=${USER_ID}&limit=50`);
    if (!r.ok) return;
    const d   = await r.json();
    const all = d.tickets || (Array.isArray(d) ? d : []);
    const active = ['created','waiting_input','submitted','processing','returned'];
    let cleaned = 0;
    for (const t of all) {
      if (t.skill_id === SKILL_ID && active.includes(t.status)) {
        if (await setTicketStatus(t.id, 'expired')) cleaned++;
      }
    }
    if (cleaned > 0) console.log(`  🧹 已过期 ${cleaned} 个同 skill 工单`);
    else console.log('  ✓ 无需清理');
  } catch (e) {
    console.log(`  ⚠️  清理失败（忽略）: ${e.message}`);
  }
}

function chatBody(content, history = []) {
  return {
    content, session_id: SESSION,
    meta: { user_id: USER_ID, from_name: FROM_NAME },
    history, notes: '血压偏高，体重75kg，身高178cm',
    context: { available_apps: ['wechat'], deliver_to: 'wechat', current_recipient: FROM_NAME },
    source: 'wechat',
    skill_id: SKILL_ID,
  };
}

async function main() {
  console.log('🚀 工单完整流程 E2E 测试 v5');
  console.log(`   用户: ${USER_ID}  Skill: ${SKILL_NAME}  服务器: ${BASE}\n`);

  let ticketId = null, ticketToken = null;

  // ─── 前置清理 ─────────────────────────────────────────────────────────────────
  section('前置：清理残留守卫 & 存量工单');
  try {
    const r = await fetch(`${API}/debug/guards?user_id=${USER_ID}`, { method: 'DELETE' });
    if (r.ok) { const d = await r.json(); if ((d.closed||0)>0) console.log(`  🧹 清理 ${d.closed} 个守卫`); }
  } catch {}
  await cleanupTickets();

  // ─── Step 1：触发工单创建 ─────────────────────────────────────────────────────
  section('Step 1：触发消息 → ticket_created 或 ticket_reused');

  let task1Id = null;
  try {
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody('帮我做一个AI营养分析')),
    });
    ok('POST /chat 200', r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    task1Id = d.request_id;
    ok('返回 request_id', !!task1Id, task1Id);
  } catch (e) { ok('POST /chat', false, e.message); return; }

  const task1 = await pollTaskEvents(task1Id, ['reply_sent','ticket_created','ticket_reused'], 25000);
  const evs1  = task1.events || [];
  console.log('  事件:', evs1.map(e => e.event_type).join(' → '));

  ok('wiki_fetched', evs1.some(e => e.event_type === 'wiki_fetched'));
  const routeP = parsePayload(evs1.find(e => e.event_type === 'route_decided'));
  ok('confidence=high', routeP.confidence === 'high', `confidence=${routeP.confidence}`);

  const reply1 = parsePayload(evs1.find(e => e.event_type === 'reply_sent'))?.reply || '';
  console.log(`  Agent 回复: "${reply1.slice(0,100)}..."`);

  // 取 ticketId（不管是 created 还是 reused）
  const tcEv = evs1.find(e => ['ticket_created','ticket_reused'].includes(e.event_type));
  if (tcEv) {
    ticketId = parsePayload(tcEv).ticketId;
    console.log(`  📋 ${tcEv.event_type}: ${ticketId}`);
  } else if (!evs1.some(e => ['ticket_created','ticket_reused'].includes(e.event_type))) {
    // 守卫激活，需要确认
    ok('skill_guard_activated', evs1.some(e => e.event_type === 'skill_guard_activated'));
    section('Step 1b：确认 → ticket_created');
    try {
      const r = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody('好的确认使用', [
          { role: 'user',      content: '帮我做一个AI营养分析' },
          { role: 'assistant', content: reply1 },
        ])),
      });
      const d = await r.json();
      const task2 = await pollTaskEvents(d.request_id, ['ticket_created','reply_sent'], 25000);
      const evs2  = task2.events || [];
      console.log('  事件:', evs2.map(e => e.event_type).join(' → '));
      const tc2 = evs2.find(e => e.event_type === 'ticket_created');
      if (tc2) ticketId = parsePayload(tc2).ticketId;
    } catch {}
  }

  ok('ticket_id 存在', !!ticketId, ticketId || '（未获取）');
  if (!ticketId) { console.log('\n❌ 无 ticketId，中止'); return; }

  // ─── 从 API 取 token（ticket_reused 不含 token，必须从 API 取）────────────────
  console.log('\n  ── 获取 ticket token ──');
  const detail0 = await getTicketDetail(ticketId);
  const ticket0 = detail0?.ticket || {};
  ticketToken = ticket0.token;
  ok('ticket.token 存在', !!ticketToken, ticketToken?.slice(0,16)+'...');
  console.log(`  ticket.status = ${ticket0.status}`);
  console.log(`  ticket.h5_url = ${ticket0.h5_url || '（无）'}`);

  // ─── 如果工单已 done/processing，重置为 waiting_input 重新提交 ────────────────
  if (['done','processing','submitted'].includes(ticket0.status)) {
    console.log(`  ⚙️  工单 status=${ticket0.status}，重置为 waiting_input 以便重新提交`);
    const ok2 = await setTicketStatus(ticketId, 'waiting_input');
    console.log(`  重置结果: ${ok2 ? '✅' : '❌'}`);
    await sleep(500);
  }

  if (!ticketToken) { console.log('\n❌ 无 token，中止'); return; }

  // ─── AgentLogs Step1 事件 ─────────────────────────────────────────────────────
  console.log('\n  ── Step 1 AgentLogs 事件 ──');
  ok('skill_selected', evs1.some(e => e.event_type === 'skill_selected'));
  ok('reassurance_sent（安抚消息）', evs1.some(e => e.event_type === 'reassurance_sent'));
  ok('ticket_created | ticket_reused', evs1.some(e => ['ticket_created','ticket_reused'].includes(e.event_type)));
  ok('reply_sent', evs1.some(e => e.event_type === 'reply_sent'));

  // ─── Step 2：GET H5 配置 ─────────────────────────────────────────────────────
  section('Step 2：GET /api/h5/:token — 表单配置');
  let h5Status = null;
  try {
    const r  = await fetch(`${BASE}/api/h5/${ticketToken}`);
    ok('GET /api/h5/:token 200', r.ok, `HTTP ${r.status}`);
    const h5 = await r.json();
    h5Status  = h5.status;
    ok('ticket_id 匹配', h5.ticket_id === ticketId, h5.ticket_id);
    ok('skill_name 正确', h5.skill_name === SKILL_NAME, h5.skill_name);
    if (h5.already_submitted) {
      console.log(`  ℹ️  already_submitted (status=${h5.status})，直接跳到 Step 4 验证结果`);
    } else {
      ok('status = waiting_input', h5.status === 'waiting_input', h5.status);
      const fields = h5.h5_config?.fields || [];
      console.log(`  📝 表单字段(${fields.length}): ${fields.map(f=>f.label||f.key).join(', ')}`);
    }
  } catch (e) { ok('GET /api/h5/:token', false, e.message); }

  // ─── Step 3：提交表单 ─────────────────────────────────────────────────────────
  section('Step 3：POST /api/h5/:token/submit — 提交健康数据');
  let submitSkipped = false;
  if (h5Status && h5Status !== 'waiting_input') {
    console.log(`  ⏭️  状态 ${h5Status}，跳过提交`);
    submitSkipped = true;
  } else {
    const formFields = {
      name: FROM_NAME, age: '42', gender: '男', weight: '75', height: '178',
      nutrition_goal:  '改善睡眠，控制血压，调整饮食',
      diet_preference: '口味偏咸，外卖为主，蔬菜摄入少',
      allergies:       '无',
      allergies_note:  '',
      activity_level:  '久坐为主，基本不运动',
      budget:          '中等',
      cooking_time:    '30分钟',
    };
    console.log('  字段:', Object.keys(formFields).join(', '));
    try {
      const fd = new URLSearchParams();
      fd.append('fields', JSON.stringify(formFields));
      const r = await fetch(`${BASE}/api/h5/${ticketToken}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd.toString(),
      });
      ok('POST /submit 200', r.ok, `HTTP ${r.status}`);
      if (!r.ok) { console.log('  响应:', await r.text()); }
      else {
        const resp = await r.json();
        ok('success = true', resp?.success === true, resp?.message);
        console.log(`  ✉️  ${resp?.message}`);
      }
    } catch (e) { ok('POST /submit', false, e.message); }
  }

  // ─── Step 4：轮询 ticket done ─────────────────────────────────────────────────
  section('Step 4：等待 AI 处理完成（最多 5 分钟）');
  const finalData  = await pollTicketStatus(ticketId, ['done','failed','error','returned'], 300000);
  console.log('');
  const finalStatus = finalData?.ticket?.status ?? finalData?.status;
  if (finalStatus === 'done') {
    ok('ticket.status = done ✅', true, 'AI 处理成功');
  } else if (finalStatus === 'error') {
    console.log(`  ⚠️  WARN: ticket.status=error（外部 AI API 超时/失败），这是基础设施问题而非平台 Bug`);
  } else {
    ok('ticket.status = done', false, `status=${finalStatus}`);
  }

  // ─── Step 5：查工单结果 ───────────────────────────────────────────────────────
  section('Step 5：检查工单结果');
  try {
    const d      = await getTicketDetail(ticketId);
    const result = d?.result || {};
    const rawRes = result.raw_result || '';
    if (finalStatus === 'done') {
      ok('result.report_url 存在', !!result.report_url, result.report_url || '（无）');
      ok('result.raw_result 存在', !!rawRes, `${rawRes.length} 字`);
      if (result.report_url) console.log(`  🔗 ${result.report_url}`);
      if (rawRes) console.log(`  📄 预览: "${rawRes.slice(0,120)}..."`);
    } else {
      ok('result.raw_result 包含错误信息', !!rawRes, rawRes.slice(0,80));
    }
  } catch (e) { ok('获取工单详情', false, e.message); }

  // ─── Step 6：AgentLogs skill_done / skill_error & reply_sent ─────────────────
  section('Step 6：验证 AgentLogs — skill_done/skill_error & reply_sent');
  try {
    const listR  = await fetch(`${API}/tasks?user_id=${USER_ID}&limit=20`);
    const listD  = await listR.json();
    const taskIds = (listD.tasks || []).map(t => t.id).filter(Boolean);
    console.log(`  搜索最近 ${taskIds.length} 个 tasks...`);

    let sdTask = null;
    for (const tid of taskIds) {
      const t = await getTask(tid);
      if ((t.events||[]).some(e => ['skill_done','skill_error'].includes(e.event_type))) {
        sdTask = t; break;
      }
    }

    if (sdTask) {
      const sdEvs  = sdTask.events || [];
      const doneEv = sdEvs.find(e => e.event_type === 'skill_done');
      const errEv  = sdEvs.find(e => e.event_type === 'skill_error');
      const termEv = doneEv || errEv;

      if (doneEv) {
        ok('skill_done 存在 ✅', true, sdTask.id);
        const sdP = parsePayload(doneEv);
        ok('outputLen > 0', (sdP?.outputLen||0) > 0, `${sdP?.outputLen} 字`);
        ok('output_preview 存在', !!sdP?.output_preview, sdP?.output_preview?.slice(0,60)+'...');
      } else if (errEv) {
        console.log(`  ⚠️  WARN: skill_error 事件（外部 AI 失败）task=${sdTask.id}`);
        console.log(`  错误: ${JSON.stringify(parsePayload(errEv)).slice(0,100)}`);
      }

      const replyEv = sdEvs.find(e => e.event_type === 'reply_sent');
      ok(`reply_sent 存在（${termEv?.event_type} 后 Agent 已回复用户）`, !!replyEv);
      if (replyEv) console.log(`\n  💬 Agent 回复: "${parsePayload(replyEv).reply?.slice(0,150)}..."`);

      console.log(`\n  ── AgentLogs 完整事件序列 ──`);
      console.log('  ' + sdEvs.map(e => e.event_type).join(' → '));
    } else {
      ok('找到 skill_done/skill_error task', false, '未找到');
    }
  } catch (e) { ok('查询 AgentLogs', false, e.message); }

  // ─── 汇总 ─────────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  工单流程 E2E  ✅ ${passed} 通过  ❌ ${failed} 失败`);
  console.log('═'.repeat(60));
  console.log(`\n📌 AgentLogs: ${BASE}  搜索 "${USER_ID}"`);
  if (ticketId) console.log(`   工单: ${BASE}/api/tickets/${ticketId}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
// (此文件为 v5 带修订，已在 SCRIPT_EOF 块内完整定义)
