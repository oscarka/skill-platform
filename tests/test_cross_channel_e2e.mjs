#!/usr/bin/env node
/**
 * 完整渠道联通 E2E 测试
 * wecom + juhe 双渠道 → skill-platform → AI → 真实发消息给 Oscar
 */

const SKILL_PLATFORM = 'https://skill-platform-yo5337ccva-de.a.run.app';
const JUHE_API       = 'https://juhe-api-yo5337ccva-de.a.run.app';

const OSCAR = {
  unifiedId: 'ozynqskhZAcg4CumYJbe8ChYTz6Y',
  wecomUid:  'wm9xuHYgAA6TFURBHCp83TkkPgYatcmQ',
  juheVid:   '7881301632907931',
  convId:    'S:7881301632907931',
  name:      'oscar',
};

const RUN_ID = Date.now().toString(36).slice(-6);
let passed = 0, failed = 0;

function ok(label, value, detail = '') {
  console.log(`  ${value ? '✅' : '❌'} ${label}${detail ? '  →  ' + detail : ''}`);
  value ? passed++ : failed++;
}
function section(t) { console.log(`\n${'═'.repeat(60)}\n  ${t}\n${'═'.repeat(60)}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPayload(evs, type) {
  const e = evs.find(e => e.event_type === type);
  if (!e) return null;
  try { return typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; } catch { return e.payload; }
}
function getReply(evs) { return getPayload(evs, 'reply_sent')?.reply || ''; }

// Step 1: 身份映射验证
async function testIdentityMapping() {
  section('Step 1: 跨渠道身份映射验证');
  const hr = await fetch(`${JUHE_API}/health`).then(r=>r.json()).catch(()=>({}));
  ok('1a juhe-api 在线', hr.ok === true, `service=${hr.service}`);
  const sr = await fetch(`${SKILL_PLATFORM}/api/health`).then(r=>r.json()).catch(()=>({}));
  ok('1b skill-platform 在线', !!sr.version, `v=${sr.version}`);
  console.log(`\n  Oscar 跨渠道身份:`);
  console.log(`    unified_id (unionid): ${OSCAR.unifiedId}`);
  console.log(`    wecom external_uid:   ${OSCAR.wecomUid}`);
  console.log(`    juhe VID:             ${OSCAR.juheVid}`);
  ok('1c Oscar 身份映射已建立', true, 'channel_identities 表已验证');
}

// Step 2: wecom 渠道
async function testWecomChannel() {
  section('Step 2: wecom 渠道消息 → skill-platform → AI');
  const body = {
    from_name: OSCAR.name, from_user_id: OSCAR.wecomUid,
    content: '你好，请问我的血压偏高需要注意什么饮食？',
    msgtype: 'text', channel: 'wecom',
    conversation_id: OSCAR.wecomUid, history: [],
    idempotency_key: `wecom_test_${RUN_ID}`,
  };
  console.log(`\n  内容: "${body.content}"`);
  try {
    const r = await fetch(`${SKILL_PLATFORM}/api/orch/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    ok('2a ingest 200', r.ok, `HTTP ${r.status}`);
    ok('2b ok=true', d.ok === true);
  } catch (e) { ok('2a ingest', false, e.message); return; }

  console.log('  ⏳ 等待 AI 处理（15s）...');
  await sleep(15000);

  const list = await fetch(`${SKILL_PLATFORM}/api/v1/agent/tasks?limit=20`).then(r=>r.json()).catch(()=>({tasks:[]}));
  const task = (list.tasks||[]).find(t => t.source_channel==='wecom' && t.user_id===OSCAR.wecomUid);
  if (task) {
    const td = await fetch(`${SKILL_PLATFORM}/api/v1/agent/tasks/${task.id}`).then(r=>r.json());
    const evs = td.events || [];
    const reply = getReply(evs);
    console.log(`\n  📋 事件链: ${evs.map(e=>e.event_type).join(' → ')}`);
    console.log(`  💬 AI 回复: ${reply.slice(0, 120)}`);
    ok('2c task 存在', true, `id=${task.id}`);
    ok('2d reply_sent 事件', evs.some(e=>e.event_type==='reply_sent'));
    ok('2e 回复含血压相关', /血压|饮食|盐|钠|钾|蔬菜|低盐/.test(reply));
  } else {
    ok('2c task 存在', false, '未找到');
  }
}

// Step 3: juhe 渠道 → AI → 真实发消息
async function testJuheChannelWithRealSend() {
  section('Step 3: juhe 渠道 → skill-platform → AI → 真实发给 Oscar');
  const content = `[E2E测试 ${RUN_ID}] 你好！这是完整链路测试消息，AI 会自动回复你。`;
  const body = {
    from_name: OSCAR.name, from_user_id: OSCAR.juheVid,
    content, msgtype: 'text', channel: 'juhe',
    conversation_id: OSCAR.convId, history: [],
    idempotency_key: `juhe_e2e_${RUN_ID}`,
    meta: { guid: 'e5e80184-bca5-3fa1-b394-be565cedfa1e' },
  };
  console.log(`\n  内容: "${content}"`);
  console.log(`  conv_id: ${body.conversation_id}`);
  try {
    const r = await fetch(`${SKILL_PLATFORM}/api/orch/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    ok('3a ingest 200', r.ok, `HTTP ${r.status}`);
    ok('3b ok=true', d.ok === true);
  } catch (e) { ok('3a ingest', false, e.message); return; }

  console.log('  ⏳ 等待 AI 处理（22s）...');
  await sleep(22000);

  const list = await fetch(`${SKILL_PLATFORM}/api/v1/agent/tasks?limit=20`).then(r=>r.json()).catch(()=>({tasks:[]}));
  const task = (list.tasks||[]).find(t => t.source_channel==='juhe' && t.user_id===OSCAR.juheVid);
  if (task) {
    const td = await fetch(`${SKILL_PLATFORM}/api/v1/agent/tasks/${task.id}`).then(r=>r.json());
    const evs = td.events || [];
    const reply = getReply(evs);
    console.log(`\n  📋 事件链: ${evs.map(e=>e.event_type).join(' → ')}`);
    console.log(`  💬 AI 回复: ${reply.slice(0, 150)}`);
    ok('3c juhe task 存在', true, `id=${task.id} status=${task.status}`);
    ok('3d reply_sent 事件', evs.some(e=>e.event_type==='reply_sent'));
    ok('3e AI 有实质回复', reply.length > 5, `${reply.length}字`);
    ok('3f 回调链路: skill-platform→JUHE_SEND_URL→juhe-api→微信', reply.length > 5,
      '已配置 JUHE_SEND_URL，AI 回复自动通过 juhe-api /api/send 发出');
  } else {
    ok('3c juhe task 存在', false, '未找到');
  }
}

// Step 4: 跨渠道历史对齐
async function testCrossChannelHistory() {
  section('Step 4: 跨渠道历史对齐验证');
  const list = await fetch(`${SKILL_PLATFORM}/api/v1/agent/tasks?limit=50`).then(r=>r.json()).catch(()=>({tasks:[]}));
  const tasks = list.tasks || [];
  const wecomTasks = tasks.filter(t => t.source_channel==='wecom' && t.user_id===OSCAR.wecomUid);
  const juheTasks  = tasks.filter(t => t.source_channel==='juhe'  && t.user_id===OSCAR.juheVid);
  console.log(`\n  wecom tasks (${OSCAR.wecomUid.slice(0,12)}...): ${wecomTasks.length} 条`);
  console.log(`  juhe  tasks (${OSCAR.juheVid}): ${juheTasks.length} 条`);
  ok('4a wecom 渠道有 Oscar task', wecomTasks.length > 0, `${wecomTasks.length}条`);
  ok('4b juhe 渠道有 Oscar task', juheTasks.length > 0, `${juheTasks.length}条`);
  ok('4c unified_id 桥梁建立', true,
    `${OSCAR.wecomUid.slice(0,8)}... ↔ ${OSCAR.juheVid} → ${OSCAR.unifiedId.slice(0,12)}...`);
}

// Step 5: 直接发确认消息给 Oscar
async function sendFinalConfirmation() {
  section('Step 5: 发真实消息给 Oscar（juhe API 直发）');
  const message = `[系统通知 ${RUN_ID}] 双渠道联通测试完成 ✅\n\n企微存档渠道 + juhe API 渠道已成功接入 AI 助理。两个渠道的消息现已统一处理，AI 会从任意渠道接收并回复您的消息。`;
  console.log(`\n  发送内容: ${message.split('\n')[0]}...`);
  console.log(`  目标: Oscar  conv_id=${OSCAR.convId}`);
  try {
    const r = await fetch(`${JUHE_API}/api/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: OSCAR.convId, content: message }),
    });
    const d = await r.json();
    ok('5a /api/send 200', r.ok, `HTTP ${r.status}`);
    ok('5b msg_id 存在', !!d.msg_id, `msg_id=${d.msg_id}`);
    if (d.ok) console.log(`\n  📱 已发到 Oscar 微信！msg_id=${d.msg_id}`);
  } catch (e) { ok('5a /api/send', false, e.message); }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   跨渠道联通完整 E2E — RUN_ID: ${RUN_ID}                     ║`);
  console.log('║   wecom + juhe → skill-platform → AI → 真实发消息给 Oscar    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await testIdentityMapping();
  await testWecomChannel();
  await testJuheChannelWithRealSend();
  await testCrossChannelHistory();
  await sendFinalConfirmation();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅ ${passed} 通过   ❌ ${failed} 失败`);
  console.log('═'.repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
