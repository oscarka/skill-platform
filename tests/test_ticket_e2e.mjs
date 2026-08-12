#!/usr/bin/env node
/**
 * 工单完整流程 E2E 测试 v6 — 超详细日志版
 * 每个 HTTP 请求的完整 URL/方法/body/状态码/响应体
 * 每次状态变化、每个 AgentLogs 事件的完整 payload 全部打印
 */

const BASE       = 'https://skill-platform-yo5337ccva-de.a.run.app';
const API        = `${BASE}/api/v1/agent`;
const USER_ID    = 'preview_test_user';
const FROM_NAME  = '测试用户';
const SKILL_ID   = 'a2a53e54-98ca-4980-8b19-c18dea109877';
const SKILL_NAME = 'AI营养师';
const SESSION    = `ticket_e2e_${Date.now()}`;

let passed = 0, failed = 0;
const START_TS = Date.now();

function ts() {
  const ms = Date.now() - START_TS;
  return `[+${(ms/1000).toFixed(1)}s]`;
}
function ok(label, value, detail = '') {
  console.log(`  ${value ? '✅' : '❌'} ${label}${detail ? '  →  ' + detail : ''}`);
  value ? passed++ : failed++;
}
function section(title) {
  console.log(`\n${'─'.repeat(70)}\n  ${ts()} ${title}\n${'─'.repeat(70)}`);
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parsePayload(ev) {
  if (!ev) return {};
  try { return typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload || {}); }
  catch { return {}; }
}

// ─── 超详细 HTTP 请求日志 ─────────────────────────────────────────────────────
async function httpLog(label, url, options = {}) {
  const method = options.method || 'GET';
  const reqBody = options.body || null;

  console.log(`\n  ┌─ ${ts()} HTTP ${method} ${label}`);
  console.log(`  │  URL: ${url}`);
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      console.log(`  │  Header: ${k}: ${v}`);
    }
  }
  if (reqBody) {
    const bodyStr = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    if (bodyStr.length > 2000) {
      console.log(`  │  Body (${bodyStr.length}bytes 截取前2000): ${bodyStr.slice(0, 2000)}...`);
    } else {
      console.log(`  │  Body: ${bodyStr}`);
    }
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, options);
    const resText = await res.text();
    const elapsed = Date.now() - t0;
    console.log(`  │  ← ${res.status} ${res.statusText} (${elapsed}ms)`);
    const ct = res.headers.get('content-type') || '';
    console.log(`  │  Content-Type: ${ct}`);
    if (resText.length > 3000) {
      console.log(`  │  Response (${resText.length}bytes 截取前3000): ${resText.slice(0, 3000)}...`);
    } else {
      console.log(`  │  Response: ${resText}`);
    }
    let resData;
    try { resData = JSON.parse(resText); } catch { resData = resText; }
    console.log(`  └─ 完成`);
    return { ok: res.ok, status: res.status, data: resData, text: resText, headers: res.headers };
  } catch (e) {
    console.log(`  │  ✗ 请求失败 (${Date.now()-t0}ms): ${e.message}`);
    console.log(`  └─ 失败`);
    throw e;
  }
}

// ─── 打印 task 完整详情 ───────────────────────────────────────────────────────
function printTaskDetail(task, label = '') {
  if (!task) { console.log(`  (task 为空)`); return; }
  console.log(`\n  ╔══ ${label || 'Task'} ══╗`);
  console.log(`  ║  id:      ${task.id || '?'}`);
  console.log(`  ║  status:  ${task.status || '?'}`);
  console.log(`  ║  user:    ${task.user_id || '?'}`);
  console.log(`  ║  channel: ${task.source_channel || '?'}`);
  console.log(`  ║  input:   ${String(task.input_content || '').slice(0,100)}`);
  if (task.created_at) console.log(`  ║  created: ${task.created_at}`);
  if (task.ended_at)   console.log(`  ║  ended:   ${task.ended_at}`);
  if (task.reply_content) console.log(`  ║  reply:   ${String(task.reply_content).slice(0,200)}`);
  const evs = task.events || [];
  console.log(`  ║  events (${evs.length}):`);
  evs.forEach((e, i) => {
    const p = parsePayload(e);
    const pStr = JSON.stringify(p);
    console.log(`  ║    [${i+1}] ${e.event_type} @ ${e.created_at || ''}`);
    if (pStr && pStr !== '{}') {
      if (pStr.length > 500) {
        console.log(`  ║         payload(${pStr.length}b): ${pStr.slice(0,500)}...`);
      } else {
        console.log(`  ║         payload: ${pStr}`);
      }
    }
  });
  console.log(`  ╚${'═'.repeat(20)}╝`);
}

// ─── 打印 ticket 完整详情 ─────────────────────────────────────────────────────
function printTicketDetail(d, label = '') {
  const t = d?.ticket || d || {};
  const r = d?.result || {};
  console.log(`\n  ╔══ ${label || 'Ticket'} ══╗`);
  console.log(`  ║  id:           ${t.id || '?'}`);
  console.log(`  ║  status:       ${t.status || '?'}`);
  console.log(`  ║  skill_id:     ${t.skill_id || '?'}`);
  console.log(`  ║  created_by:   ${t.created_by || '?'}`);
  console.log(`  ║  patient_name: ${t.patient_name || '?'}`);
  console.log(`  ║  request_id:   ${t.request_id || '(无)'}`);
  console.log(`  ║  token:        ${t.token ? t.token.slice(0,16)+'...' : '(无)'}`);
  console.log(`  ║  h5_url:       ${t.h5_url || '(无)'}`);
  console.log(`  ║  expires_at:   ${t.expires_at ? new Date(Number(t.expires_at)).toISOString() : '?'}`);
  console.log(`  ║  created_at:   ${t.created_at || '?'}`);
  console.log(`  ║  updated_at:   ${t.updated_at || '?'}`);
  console.log(`  ║  h5_submitted: ${t.h5_submitted_at || '(无)'}`);
  console.log(`  ║  ai_started:   ${t.ai_started_at || '(无)'}`);
  console.log(`  ║  ai_completed: ${t.ai_completed_at || '(无)'}`);
  if (r.raw_result) {
    const rr = String(r.raw_result);
    console.log(`  ║  result.raw(${rr.length}字): ${rr.slice(0,300)}${rr.length>300?'...':''}`);
  }
  if (r.report_url) console.log(`  ║  result.report_url: ${r.report_url}`);
  const inputs = d?.inputs || [];
  if (inputs.length > 0) {
    console.log(`  ║  inputs(${inputs.length}):`);
    inputs.forEach(inp => {
      console.log(`  ║    [${inp.field_type}] ${inp.field_key}: ${(inp.value||inp.file_name||'').toString().slice(0,80)}`);
    });
  }
  console.log(`  ╚${'═'.repeat(20)}╝`);
}

async function getTask(taskId) {
  const r = await fetch(`${API}/tasks/${taskId}`);
  return r.ok ? r.json() : { events: [] };
}

async function pollTaskEvents(taskId, untilTypes, timeoutMs = 25000) {
  console.log(`  ⏳ ${ts()} 等待事件 [${untilTypes.join('|')}] taskId=${taskId} timeout=${timeoutMs/1000}s`);
  const start = Date.now();
  let lastEvCount = 0;
  while (Date.now() - start < timeoutMs) {
    const d = await getTask(taskId);
    const evs = d.events || [];
    if (evs.length !== lastEvCount) {
      console.log(`  ⚡ ${ts()} 事件更新: ${lastEvCount} → ${evs.length}: [${evs.map(e=>e.event_type).join(', ')}]`);
      lastEvCount = evs.length;
    }
    if (untilTypes.some(t => evs.some(e => e.event_type === t))) return d;
    await sleep(1000);
  }
  return getTask(taskId);
}

async function pollTicketStatus(ticketId, targetStatuses, timeoutMs = 600000) {
  console.log(`  ⏳ ${ts()} 轮询工单 ${ticketId.slice(0,8)} 状态 目标:[${targetStatuses.join('|')}] timeout=${timeoutMs/1000}s`);
  const start = Date.now();
  let lastStatus = null;
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
    if (r.ok) {
      const d = await r.json();
      const status = d.ticket?.status ?? d.status;
      if (status !== lastStatus) {
        console.log(`  📊 ${ts()} 状态变化: ${lastStatus || '(初始)'} → ${status}`);
        lastStatus = status;
      } else {
        process.stdout.write(`    ⏳ status=${status} (${Math.round((Date.now()-start)/1000)}s)...\r`);
      }
      if (targetStatuses.includes(status)) {
        console.log(`\n  ✅ ${ts()} 达到目标状态: ${status}`);
        return d;
      }
    }
    await sleep(3000);
  }
  console.log(`\n  ⏰ ${ts()} 超时，获取最终状态`);
  const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
  return r.ok ? r.json() : null;
}

async function setTicketStatus(ticketId, status) {
  const res = await httpLog('setStatus', `${BASE}/api/tickets/${ticketId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

async function cleanupTickets() {
  console.log(`  🔍 ${ts()} 查询 ${USER_ID} 的存量工单`);
  try {
    const res = await httpLog('listTickets', `${BASE}/api/tickets?created_by=${USER_ID}&limit=50`);
    const all = res.data?.tickets || (Array.isArray(res.data) ? res.data : []);
    console.log(`  📋 ${ts()} 共 ${all.length} 个工单:`);
    all.forEach(t => console.log(`    ${t.id.slice(0,8)} status=${t.status} skill=${t.skill_id===SKILL_ID?'✓':'✗'} created=${t.created_at}`));
    const active = ['created','waiting_input','submitted','processing','returned'];
    let cleaned = 0;
    for (const t of all) {
      if (t.skill_id === SKILL_ID && active.includes(t.status)) {
        console.log(`  🧹 ${ts()} 清理 ${t.id.slice(0,8)} status=${t.status}`);
        if (await setTicketStatus(t.id, 'expired')) cleaned++;
      }
    }
    if (cleaned > 0) console.log(`  ✅ ${ts()} 过期 ${cleaned} 个工单`);
    else console.log(`  ✓ ${ts()} 无需清理`);
  } catch (e) {
    console.log(`  ⚠️  清理失败: ${e.message}`);
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
  console.log('🚀 工单完整流程 E2E 测试 v6 — 超详细日志');
  console.log(`   用户: ${USER_ID}  Skill: ${SKILL_NAME}`);
  console.log(`   服务器: ${BASE}`);
  console.log(`   Session: ${SESSION}`);
  console.log(`   开始时间: ${new Date().toISOString()}\n`);

  let ticketId = null, ticketToken = null;

  // ─── 前置清理 ───────────────────────────────────────────────────────────────
  section('前置：清理残留守卫 & 存量工单');

  console.log(`\n  → ${ts()} 清理守卫`);
  try {
    const res = await httpLog('deleteGuards', `${API}/debug/guards?user_id=${USER_ID}`, { method: 'DELETE' });
    if (res.ok) {
      const closed = res.data?.closed || 0;
      console.log(`  守卫清理结果: closed=${closed}`);
    }
  } catch (e) { console.log(`  ⚠️  守卫清理失败: ${e.message}`); }

  await cleanupTickets();

  // ─── Step 1：触发工单创建 ───────────────────────────────────────────────────
  section('Step 1：触发消息 → ticket_created 或 ticket_reused');

  const chatPayload = chatBody('帮我做一个AI营养分析');
  console.log(`\n  → ${ts()} 完整 chat 请求体:`);
  console.log(JSON.stringify(chatPayload, null, 4).split('\n').map(l => '  ' + l).join('\n'));

  let task1Id = null;
  try {
    const res = await httpLog('postChat', `${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatPayload),
    });
    ok('POST /chat 200', res.ok, `HTTP ${res.status}`);
    task1Id = res.data?.request_id;
    ok('返回 request_id', !!task1Id, task1Id);
    console.log(`\n  完整 chat 响应:`);
    console.log(JSON.stringify(res.data, null, 4).split('\n').map(l => '  ' + l).join('\n'));
  } catch (e) { ok('POST /chat', false, e.message); return; }

  const task1 = await pollTaskEvents(task1Id, ['reply_sent','ticket_created','ticket_reused'], 30000);
  const evs1  = task1.events || [];

  console.log(`\n  → ${ts()} Task1 完整详情:`);
  printTaskDetail(task1, 'Task1 (chat trigger)');

  ok('wiki_fetched', evs1.some(e => e.event_type === 'wiki_fetched'));
  const routeP = parsePayload(evs1.find(e => e.event_type === 'route_decided'));
  ok('confidence=high', routeP.confidence === 'high', `confidence=${routeP.confidence}`);

  const reply1 = parsePayload(evs1.find(e => e.event_type === 'reply_sent'))?.reply || '';
  console.log(`\n  Agent 回复 (全文):\n  "${reply1}"`);

  const tcEv = evs1.find(e => ['ticket_created','ticket_reused'].includes(e.event_type));
  if (tcEv) {
    const p = parsePayload(tcEv);
    ticketId = p.ticketId;
    console.log(`\n  📋 ${tcEv.event_type} 完整 payload:`);
    console.log(JSON.stringify(p, null, 4).split('\n').map(l => '  ' + l).join('\n'));
  } else {
    ok('skill_guard_activated', evs1.some(e => e.event_type === 'skill_guard_activated'));
    section('Step 1b：确认 → ticket_created');
    try {
      const confirmBody = chatBody('好的确认使用', [
        { role: 'user', content: '帮我做一个AI营养分析' },
        { role: 'assistant', content: reply1 },
      ]);
      const res = await httpLog('confirmChat', `${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmBody),
      });
      const task2 = await pollTaskEvents(res.data.request_id, ['ticket_created','reply_sent'], 25000);
      printTaskDetail(task2, 'Task1b (confirm)');
      const tc2 = (task2.events||[]).find(e => e.event_type === 'ticket_created');
      if (tc2) { ticketId = parsePayload(tc2).ticketId; }
    } catch (e) { console.log(`  ⚠️  确认失败: ${e.message}`); }
  }

  ok('ticket_id 存在', !!ticketId, ticketId || '（未获取）');
  if (!ticketId) { console.log('\n❌ 无 ticketId，中止'); return; }

  // ─── 获取 ticket 详情 ────────────────────────────────────────────────────────
  console.log(`\n  → ${ts()} 获取 ticket 完整详情 ticketId=${ticketId}`);
  const res0 = await httpLog('getTicket', `${BASE}/api/tickets/${ticketId}`);
  printTicketDetail(res0.data, 'Ticket (初始状态)');

  const ticket0 = res0.data?.ticket || res0.data || {};
  ticketToken = ticket0.token;
  ok('ticket.token 存在', !!ticketToken, ticketToken?.slice(0,16)+'...');

  if (['done','processing','submitted'].includes(ticket0.status)) {
    console.log(`\n  ⚙️  ${ts()} 工单 status=${ticket0.status}，重置为 waiting_input`);
    await setTicketStatus(ticketId, 'waiting_input');
    await sleep(500);
    const recheck = await httpLog('recheckTicket', `${BASE}/api/tickets/${ticketId}`);
    printTicketDetail(recheck.data, 'Ticket (重置后)');
  }

  if (!ticketToken) { console.log('\n❌ 无 token，中止'); return; }

  console.log(`\n  ── ${ts()} Step 1 AgentLogs 事件验证 ──`);
  ok('skill_selected',          evs1.some(e => e.event_type === 'skill_selected'));
  ok('reassurance_sent',        evs1.some(e => e.event_type === 'reassurance_sent'));
  ok('ticket_created|reused',   evs1.some(e => ['ticket_created','ticket_reused'].includes(e.event_type)));
  ok('reply_sent',              evs1.some(e => e.event_type === 'reply_sent'));

  // ─── Step 2：GET H5 配置 ────────────────────────────────────────────────────
  section(`Step 2：GET /api/h5/:token — 表单配置`);
  console.log(`\n  → ${ts()} token=${ticketToken}`);
  const h5Res = await httpLog('getH5Config', `${BASE}/api/h5/${ticketToken}`);
  const h5 = h5Res.data;
  let h5Status = h5?.status;

  ok('GET /api/h5/:token 200',  h5Res.ok, `HTTP ${h5Res.status}`);
  ok('ticket_id 匹配',           h5?.ticket_id === ticketId, h5?.ticket_id);
  ok('skill_name 正确',          h5?.skill_name === SKILL_NAME, h5?.skill_name);

  console.log(`\n  H5 配置完整字段:`);
  console.log(`    ticket_id:         ${h5?.ticket_id}`);
  console.log(`    skill_id:          ${h5?.skill_id}`);
  console.log(`    skill_name:        ${h5?.skill_name}`);
  console.log(`    status:            ${h5?.status}`);
  console.log(`    already_submitted: ${h5?.already_submitted}`);
  console.log(`    wiki_prefill:      ${JSON.stringify(h5?.wiki_prefill || null)}`);
  const fields = h5?.h5_config?.fields || [];
  console.log(`    字段数:            ${fields.length}`);
  fields.forEach((f, i) => {
    console.log(`      [${i+1}] key=${f.key} label=${f.label} type=${f.type} required=${f.required}`);
  });

  if (!h5?.already_submitted) {
    ok('status = waiting_input', h5?.status === 'waiting_input', h5?.status);
  }

  // ─── Step 3：提交表单 ───────────────────────────────────────────────────────
  section('Step 3：POST /api/h5/:token/submit — 提交健康数据');

  if (h5Status && h5Status !== 'waiting_input') {
    console.log(`  ⏭️  状态 ${h5Status}，跳过提交`);
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
    console.log(`\n  表单字段 (完整):`);
    for (const [k,v] of Object.entries(formFields)) {
      console.log(`    ${k}: "${v}"`);
    }

    const fd = new URLSearchParams();
    fd.append('fields', JSON.stringify(formFields));
    const submitBody = fd.toString();
    console.log(`\n  URLEncoded body (${submitBody.length}bytes): ${submitBody}`);

    const submitRes = await httpLog('submitH5', `${BASE}/api/h5/${ticketToken}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: submitBody,
    });

    ok('POST /submit 200',  submitRes.ok, `HTTP ${submitRes.status}`);
    ok('success = true',    submitRes.data?.success === true, submitRes.data?.message);

    await sleep(1500);
    console.log(`\n  → ${ts()} 提交后立即检查工单状态`);
    const postSubmitRes = await httpLog('getTicketPostSubmit', `${BASE}/api/tickets/${ticketId}`);
    printTicketDetail(postSubmitRes.data, 'Ticket (提交后立即)');
  }

  // ─── Step 4：轮询 ──────────────────────────────────────────────────────────
  section('Step 4：等待 AI 处理完成（最多 10 分钟）');
  const finalData = await pollTicketStatus(ticketId, ['done','failed','error','returned'], 600000);
  console.log('');

  console.log(`\n  → ${ts()} 获取最终工单完整详情`);
  const finalDetailRes = await httpLog('getFinalTicket', `${BASE}/api/tickets/${ticketId}`);
  printTicketDetail(finalDetailRes.data, 'Ticket (最终状态)');

  const finalStatus = finalDetailRes.data?.ticket?.status ?? finalDetailRes.data?.status;
  if (finalStatus === 'done') {
    ok('ticket.status = done ✅', true, 'AI 处理成功');
  } else if (finalStatus === 'error') {
    console.log(`  ⚠️  WARN: ticket.status=error（AI API 超时/失败），基础设施问题`);
  } else {
    ok('ticket.status = done', false, `status=${finalStatus}`);
  }

  // ─── Step 5：工单结果 ───────────────────────────────────────────────────────
  section('Step 5：检查工单结果');
  const d      = finalDetailRes.data;
  // report_url 可在 d.result 或 d.ticket 中，优先取 d.result（更新鲜）
  const result = d?.result || {};
  const ticket = d?.ticket || {};
  const reportUrl = result.report_url || ticket.report_url
    || finalData?.result?.report_url || finalData?.report_url || '';
  const rawRes = result.raw_result || ticket.raw_result || finalData?.raw_result || '';

  console.log(`\n  result 完整字段:`);
  console.log(`    raw_result (${rawRes.length}字): ${rawRes.slice(0,500)}${rawRes.length>500?'...':''}`);
  console.log(`    report_url:  ${reportUrl || '(无)'}`);
  const aiLogStr = result.ai_log || '';
  console.log(`    ai_log:      ${aiLogStr.length} bytes`);
  if (aiLogStr) {
    try {
      const logArr = JSON.parse(aiLogStr);
      console.log(`    ai_log 条数: ${logArr.length}`);
      logArr.slice(0,5).forEach((e, i) => {
        console.log(`      [${i+1}] ${JSON.stringify(e).slice(0,200)}`);
      });
    } catch { console.log(`    ai_log (raw): ${aiLogStr.slice(0,200)}`); }
  }

  if (finalStatus === 'done') {
    ok('result.report_url 存在', !!reportUrl, reportUrl || '（无）');
    ok('result.raw_result 存在', !!rawRes, `${rawRes.length} 字`);
  } else {
    ok('result.raw_result 包含错误信息', !!rawRes, rawRes.slice(0,80));
  }

  // ─── Step 6：AgentLogs 完整验证 ────────────────────────────────────────────
  section('Step 6：验证 AgentLogs — 完整事件链');

  console.log(`\n  → ${ts()} 获取 ${USER_ID} 的所有 tasks`);
  const listRes = await httpLog('listTasks', `${API}/tasks?user_id=${USER_ID}&limit=20`);
  const taskList = listRes.data?.tasks || [];
  console.log(`\n  共 ${taskList.length} 个 tasks:`);
  taskList.forEach((t, i) => {
    console.log(`    [${i+1}] id=${t.id}  status=${t.status}  channel=${t.source_channel}`);
    console.log(`          input=${String(t.input_content||'').slice(0,80)}`);
  });

  const targetPrefix = ticketId ? `req_h5_${ticketId.slice(0,8)}` : null;
  console.log(`\n  → ${ts()} 逐一拉取每个 task 详情 (目标前缀: ${targetPrefix || 'N/A'})`);

  let sdTask = null;
  for (const t of taskList) {
    console.log(`\n  ── 拉取 task: ${t.id} ──`);
    const taskDetail = await httpLog('getTask', `${API}/tasks/${t.id}`);
    const taskData = taskDetail.data;
    const evs = taskData?.events || [];
    console.log(`  事件数: ${evs.length}  列表: [${evs.map(e=>e.event_type).join(', ')}]`);

    if (evs.some(e => ['skill_done','skill_error'].includes(e.event_type))) {
      if (!sdTask || (targetPrefix && t.id.startsWith(targetPrefix))) {
        sdTask = taskData;
        console.log(`  ✓ 选中为目标 task`);
      }
    }
  }

  if (sdTask) {
    console.log(`\n  → ${ts()} 目标 task 完整详情:`);
    printTaskDetail(sdTask, 'AgentLogs 处理 Task');

    const sdEvs  = sdTask.events || [];
    const doneEv = sdEvs.find(e => e.event_type === 'skill_done');
    const errEv  = sdEvs.find(e => e.event_type === 'skill_error');

    if (doneEv) {
      ok('skill_done 存在 ✅', true, sdTask.id);
      const sdP = parsePayload(doneEv);
      console.log(`\n  skill_done 完整 payload:`);
      console.log(JSON.stringify(sdP, null, 4).split('\n').map(l => '  ' + l).join('\n'));
      ok('outputLen > 0', (sdP?.outputLen||0) > 0, `${sdP?.outputLen} 字`);
      ok('output_preview 存在', !!sdP?.output_preview, sdP?.output_preview?.slice(0,60)+'...');
    } else if (errEv) {
      const errP = parsePayload(errEv);
      console.log(`\n  ⚠️  skill_error 完整 payload:`);
      console.log(JSON.stringify(errP, null, 4).split('\n').map(l => '  ' + l).join('\n'));
    }

    const replyEv = sdEvs.find(e => e.event_type === 'reply_sent');
    ok(`reply_sent 存在`, !!replyEv, replyEv ? '✅ Agent 已通知用户' : '❌ 未通知用户');
    if (replyEv) {
      const rp = parsePayload(replyEv);
      console.log(`\n  reply_sent 完整 payload:`);
      console.log(JSON.stringify(rp, null, 4).split('\n').map(l => '  ' + l).join('\n'));
    }

    console.log(`\n  ── 完整事件序列 ──`);
    console.log('  ' + sdEvs.map(e => e.event_type).join(' → '));
  } else {
    ok('找到 skill_done/skill_error task', false, '未找到');
  }

  // ─── 汇总 ──────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - START_TS;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  工单流程 E2E v6  ✅ ${passed} 通过  ❌ ${failed} 失败  总耗时: ${(totalMs/1000).toFixed(1)}s`);
  console.log('═'.repeat(70));
  console.log(`\n📌 AgentLogs: ${BASE}  搜索 "${USER_ID}"`);
  if (ticketId) console.log(`   工单详情: ${BASE}/api/tickets/${ticketId}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
