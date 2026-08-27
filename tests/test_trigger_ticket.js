/**
 * test_trigger_ticket.js
 * 触发已创建的工单（包含补充信息和化验单数据），验证沙箱执行及报告生成
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TICKET_ID = '9ff1150e-f36e-410b-9999-108c2e80dd26';

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, data: await res.json() };
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
}

async function main() {
    console.log('====================================================');
    console.log(`🚀 开始测试工单 ${TICKET_ID} 沙箱 AI 分析与报告生成`);
    console.log('====================================================\n');

    console.log('1. 获取工单信息...');
    const infoRes = await getJson(`${BASE_URL}/api/tickets/${TICKET_ID}`);
    const token = infoRes.data.ticket.token;
    console.log(`  -> 工单 Token: ${token}, 准备提交...`);

    const submitRes = await postJson(`${BASE_URL}/api/h5/${token}/submit`, {
        inputs: {},
        notes: '上海交通大学医学院附属瑞金医院检验科报告单 | 标本号: 20260827_888\n空腹血糖: 7.8 mmol/L (偏高)\n糖化血红蛋白(HbA1c): 7.2% (偏高)\n甘油三酯: 2.9 mmol/L (偏高)\n总胆固醇: 6.3 mmol/L (偏高)'
    });
    console.log('  -> 提交响应:', submitRes.data);

    console.log('\n2. 轮询监控工单执行进度（每 3 秒检查一次）...');
    let done = false;
    for (let i = 1; i <= 15; i++) {
        await delay(3000);
        const ticketRes = await getJson(`${BASE_URL}/api/tickets/${TICKET_ID}`);
        const ticket = ticketRes.data.ticket;
        console.log(`  [第 ${i * 3} 秒] 工单状态: ${ticket.status} (${ticket.status_label})`);

        if (ticket.status === 'done') {
            done = true;
            console.log('\n🎉 工单执行成功！状态已变为 done！');
            console.log('报告 URL: ' + ticket.report_url);
            
            // 获取生成的报告预览
            const reportRes = await fetch(`${BASE_URL}/api/results/${TICKET_ID}/report`);
            const reportHtml = await reportRes.text();
            console.log('\n--- AI 生成的分析报告内容片段 ---');
            console.log(reportHtml.slice(0, 500) + '...\n');
            break;
        } else if (ticket.status === 'error') {
            console.error('\n❌ 工单状态为 error，执行失败！');
            break;
        }
    }

    if (!done) {
        console.log('\n⚠️ 执行尚未结束，请检查日志');
    }
}

main().catch(console.error);
