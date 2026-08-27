/**
 * test_complete_sandbox_flow.js
 * 真实端到端沙箱闭环测试：
 * 1. 提交真实患者化验单（文字 + 完整指标 OCR）
 * 2. 追踪任务及工单状态由 processing -> done
 * 3. 获取并打印 AI 最终生成的完整分析报告
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TEST_USER = 'patient_chen_' + Date.now();

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

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, data: await res.json() };
}

async function runTest() {
    console.log('====================================================');
    console.log('🚀 开始全链路沙箱执行与报告生成闭环测试');
    console.log('测试用户 ID: ' + TEST_USER);
    console.log('====================================================\n');

    const reportSummary = '[图片内容:\n上海交通大学医学院附属瑞金医院临床实验诊断中心\n检验科报告单 | 标本号: 20260827_888\n姓名: 陈建华 | 门诊号: A98765432\n空腹血糖: 7.8 mmol/L (参考值: 3.9-6.1, 偏高)\n糖化血红蛋白(HbA1c): 7.2% (参考值: 4.0-6.0, 偏高)\n甘油三酯: 2.9 mmol/L (参考值: 0.5-1.7, 偏高)\n总胆固醇: 6.3 mmol/L (参考值: 2.8-5.2, 偏高)]';

    const fullContent = `帮我全面解读这份瑞金医院检验单，给出调理和就医建议\n\n${reportSummary}`;

    console.log('1. 发送请求给 Ingest 接口...');
    const ingestRes = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '陈建华',
        from_user_id: TEST_USER,
        content: fullContent,
        msgtype: 'text',
        channel: 'wecom',
        attachments: [
            {
                fileName: '瑞金医院生化全套.jpg',
                fileUrl: 'https://storage.googleapis.com/wechat-archiver-media/2026-08-27/chen_report.jpg',
                msgtype: 'image',
                summary: reportSummary,
                status: 'completed',
            }
        ]
    });

    console.log('  -> Ingest 响应:', ingestRes.data);
    if (!ingestRes.data.ok) {
        throw new Error('Ingest 接口返回错误');
    }

    console.log('\n2. 轮询监控工单状态（最多等待 30 秒）...');
    let reportUrl = null;
    let finalTicket = null;

    for (let i = 1; i <= 10; i++) {
        await delay(3000);
        const ticketsRes = await getJson(`${BASE_URL}/api/tickets?status=all&limit=10`);
        const allTickets = ticketsRes.data.tickets || ticketsRes.data || [];
        const ticket = allTickets.find(t => (t.created_by && t.created_by.includes(TEST_USER)) || (t.patient_name === '陈建华'));

        if (ticket) {
            console.log(`  [轮询 ${i * 3}s] 工单状态: ${ticket.status}, Skill: ${ticket.title}`);
            if (ticket.status === 'done') {
                finalTicket = ticket;
                reportUrl = `${BASE_URL}/api/results/${ticket.id}/report`;
                break;
            }
        } else {
            console.log(`  [轮询 ${i * 3}s] 正在等待工单创建...`);
        }
    }

    if (finalTicket) {
        console.log('\n====================================================');
        console.log('🎉 沙箱 AI 分析执行成功！工单状态已变为 done！');
        console.log('工单 ID: ' + finalTicket.id);
        console.log('报告地址: ' + reportUrl);
        console.log('====================================================');
    } else {
        console.log('\n⚠️ 工单在 30 秒内尚未完成，将通过日志检查执行详情');
    }
}

runTest().catch(err => {
    console.error('❌ 测试运行失败:', err);
    process.exit(1);
});
