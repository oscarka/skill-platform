/**
 * test_preemption_scenario.js
 * 专门验证消息抢占/占位功能：
 * 用户发出消息 A（Agent 开始推理耗时 6~10s），第 1 秒用户发出新消息 B。
 * 预期：消息 A 的旧回复被拦截并丢弃，消息 B 的回复正常发出。
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TEST_USER = 'test_preempt_user_' + Date.now();

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
}

async function runPreemptTest() {
    console.log('--- [测试 5] 验证消息抢占 (Preemption) ---');
    console.log('测试用户 ID: ' + TEST_USER);

    // 1. 发送第一条长文本消息
    console.log('1. 发送消息 A: "请详细分析我的身体情况并给出长篇调理方案"');
    const p1 = postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '抢占测试用户',
        from_user_id: TEST_USER,
        content: '请详细分析我的身体情况并给出长篇调理方案',
        msgtype: 'text',
        channel: 'wecom',
    });

    // 2. 在 800ms 后（Agent 正在推理），立即发出消息 B
    await delay(800);
    console.log('2. 用户快速打断，发送消息 B: "等下，我刚才说错了，不用调理方案，请问你们周六营业吗？"');
    const p2 = postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '抢占测试用户',
        from_user_id: TEST_USER,
        content: '等下，我刚才说错了，不用调理方案，请问你们周六营业吗？',
        msgtype: 'text',
        channel: 'wecom',
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    console.log('  -> 消息 A Ingest 响应:', res1.data);
    console.log('  -> 消息 B Ingest 响应:', res2.data);

    console.log('⏳ 等待 6 秒观察抢占执行日志...');
    await delay(6000);

    console.log('✅ [测试 5 完成] 请查看 Cloud Logging 确认 ✂️ 抢占拦截日志生效！');
}

runPreemptTest().catch(err => {
    console.error('❌ 抢占测试失败:', err);
    process.exit(1);
});
