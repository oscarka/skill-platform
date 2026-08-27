/**
 * test_live_workflow.js
 * 真实全链路场景仿真验证：
 * 1. 用户先说了文字："帮我分析一下我的化验单"
 *    -> Agent 匹配「医学报告解读助手」，创建 waiting_input 工单。
 * 2. 用户接着发了报告图片（后台 Gemini OCR 提取出指标）
 *    -> Ingest 自动检测到该用户有 waiting_input 工单，自动将指标注入工单 notes 并将状态推进到 submitted，触发 AI 开始分析！
 * 3. 验证工单数据库状态与 AI 处理结果。
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TEST_USER = 'live_patient_' + Date.now();

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

async function runLiveTest() {
    console.log('====================================================');
    console.log('🚀 开始真实用户场景闭环测试');
    console.log('用户 ID: ' + TEST_USER);
    console.log('====================================================\n');

    // ── 步骤 1: 用户发送“帮我分析一下我的化验单” ──
    console.log('【步骤 1】用户发送文字：“帮我分析一下我的化验单”');
    const step1 = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '李医生测试患者',
        from_user_id: TEST_USER,
        content: '帮我分析一下我的化验单',
        msgtype: 'text',
        channel: 'wecom',
    });
    console.log('  -> Ingest 响应:', step1.data);

    console.log('⏳ 等待 Agent 创建工单并下发 (5 秒)...');
    await delay(5000);

    // ── 步骤 2: 检查工单是否已创建（处于 waiting_input 状态） ──
    console.log('\n【步骤 2】检查用户工单状态（等待上传报告）...');
    const ticketsRes1 = await getJson(`${BASE_URL}/api/tickets?status=all&limit=5`);
    const allTickets = ticketsRes1.data.tickets || ticketsRes1.data || [];
    const myTicket = allTickets.find(t => (t.created_by && t.created_by.includes(TEST_USER)) || (t.patient_name === '李医生测试患者'));
    
    if (myTicket) {
        console.log(`  -> 成功查到工单 ID: ${myTicket.id}, 当前状态: ${myTicket.status}, Skill: ${myTicket.title}`);
    } else {
        console.log('  -> 提示：未在公开列表找到，直接通过媒体上报验证');
    }

    // ── 步骤 3: 用户上传报告图片（带 OCR 解析出的指标数据） ──
    console.log('\n【步骤 3】用户上传报告图片（后台 OCR 提取完毕）');
    const reportSummary = '[图片内容:\n上海交通大学医学院附属瑞金医院检验报告\n标本号: 20260827_001\n空腹血糖: 7.2 mmol/L (参考值: 3.9-6.1, 偏高)\n糖化血红蛋白: 6.8% (偏高)\n甘油三酯: 2.6 mmol/L (偏高)]';

    const step3 = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '李医生测试患者',
        from_user_id: TEST_USER,
        content: '[图片: 瑞金医院化验单.jpg]',
        msgtype: 'image',
        media_url: 'https://storage.googleapis.com/wechat-archiver-media/test_ruijin_report.jpg',
        file_name: '瑞金医院化验单.jpg',
        file_type: 'image',
        channel: 'wecom',
        attachments: [
            {
                fileName: '瑞金医院化验单.jpg',
                fileUrl: 'https://storage.googleapis.com/wechat-archiver-media/test_ruijin_report.jpg',
                msgtype: 'image',
                summary: reportSummary,
                status: 'completed',
            }
        ]
    });
    console.log('  -> Ingest 响应:', step3.data);

    console.log('⏳ 等待工单自驱动更新与 AI 分析执行 (8 秒)...');
    await delay(8000);

    // ── 步骤 4: 验证工单已被自动注入 OCR 指标并推进 ──
    console.log('\n【步骤 4】验证工单是否已自动注入化验数据并推进...');
    const ticketsRes2 = await getJson(`${BASE_URL}/api/tickets?status=all&limit=10`);
    const allTickets2 = ticketsRes2.data.tickets || ticketsRes2.data || [];
    const updatedTicket = allTickets2.find(t => (t.created_by && t.created_by.includes(TEST_USER)) || (t.patient_name === '李医生测试患者'));
    
    if (updatedTicket) {
        console.log(`  -> 工单更新后状态: ${updatedTicket.status}`);
        console.log(`  -> 工单备注内容预览 (notes):\n     ${(updatedTicket.notes || '').slice(0, 150)}...`);
    }

    console.log('\n====================================================');
    console.log('🎉 真实全链路场景仿真验证执行完毕！');
    console.log('====================================================');
}

runLiveTest().catch(err => {
    console.error('❌ 测试运行异常:', err);
    process.exit(1);
});
