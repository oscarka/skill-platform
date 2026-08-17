/**
 * test_directive_variants.mjs
 * 测试 new_created 守卫 directive 的不同措辞对 Agent 回复风格的影响
 * 使用 DeepSeek API（OpenAI 兼容）
 *
 * 运行：node tests/test_directive_variants.mjs
 */
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// 手动加载 .env
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const BASE_URL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const API_KEY  = process.env.DOUBAO_API_KEY;
const MODEL    = 'doubao-1.5-pro-32k-250115';

if (!API_KEY) { console.error('❌ 缺少 DOUBAO_API_KEY'); process.exit(1); }

const SKILL_NAME = 'AI营养师';
const SKILL_DESC = 'AI全维度营养顾问，覆盖个性化饮食方案、慢病营养管理、运动营养等模块，输入用户画像后自动生成专属方案';

// ── 变体（只测 V3 vs V3.5 vs V5，聚焦「加不加简介」的差距）──────────────
const VARIANTS = [
  {
    label: 'V3【当前版本】信息式，无服务简介',
    directive:
      `[服务匹配提示] 系统检测到用户可能对「${SKILL_NAME}」感兴趣（置信度：高）。` +
      `如果当前对话场景自然合适，可以顺带提及；如果用户正在聊别的事或问题与此无关，正常回答即可，不必强制推荐。`,
  },
  {
    label: 'V3.5【建议】信息式+括号简介+明确不要求确认',
    directive:
      `[服务匹配提示] 系统检测到用户可能对「${SKILL_NAME}」感兴趣（置信度：高）。` +
      `如果当前对话场景自然合适，可顺带提及（${SKILL_DESC.slice(0, 60)}）；` +
      `不必要求用户确认，感兴趣自然会主动询问。` +
      `若用户正在聊别的事，正常回答即可。`,
  },
  {
    label: 'V4【对照】信息式+句子式简介（原测试中较生硬）',
    directive:
      `[服务匹配提示] 系统检测到用户可能对「${SKILL_NAME}」感兴趣（置信度：高）。` +
      `如果当前对话场景自然合适，可以顺带一提：${SKILL_DESC.slice(0, 80)}。` +
      `不必强制推荐，用户有意向会自然询问。`,
  },
];

// ── 测试场景（6种，每种2条消息，覆盖更多真实情况）────────────────────────────
const SCENARIOS = [
  {
    label: '场景A：直接问和服务高度相关的健康问题',
    messages: [
      '我最近吃东西总是觉得没精神，想改善一下饮食',
      '我血糖有点高，不知道吃什么比较好',
    ],
  },
  {
    label: '场景B：聊无关的日常闲聊话题',
    messages: [
      '最近天气真的好热啊，你平时怎么消暑',
      '我今天刚买了双新跑鞋，好看',
    ],
  },
  {
    label: '场景C：用户主动问有没有这类服务',
    messages: [
      '你们有帮我规划饮食的服务吗？',
      '有什么AI营养方面的功能可以用吗',
    ],
  },
  {
    label: '场景D：和服务有一点相关，但没有明确表达需求',
    messages: [
      '我想减肥但不知道从哪里开始',
      '运动完感觉很累，吃什么恢复比较快',
    ],
  },
  {
    label: '场景E：用户上一条消息已经在问其他事，这条继续问别的',
    messages: [
      '上次你说的血压控制方法有用，谢谢',
      '我睡眠质量不太好，有什么改善方法',
    ],
  },
  {
    label: '场景F：用户明确表达不需要推荐',
    messages: [
      '我不需要什么服务，我就是随便聊聊',
      '我已经有营养师了，就是想聊几句',
    ],
  },
];

const SYSTEM_BASE = `你是健康顾问小薇，专业的健康顾问，根据客户的健康档案和问题提供专业且个性化的建议。
回复风格：亲切专业，回复控制在150字以内。
要求：不要使用 Markdown 格式，不要每句都称呼客户名字。`;

// ── 调用 DeepSeek API ─────────────────────────────────────────────────────────
async function callAI(systemPrompt, userMessage) {
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
      }),
    });
    const d = await resp.json();
    return d.choices?.[0]?.message?.content?.trim() || `❌ API error: ${JSON.stringify(d).slice(0,100)}`;
  } catch (e) {
    return `❌ Fetch error: ${e.message}`;
  }
}

// ── 颜色 helpers ──────────────────────────────────────────────────────────────
const c = {
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

// ── 主流程 ────────────────────────────────────────────────────────────────────
console.log(c.bold('\n=== Directive 措辞对比测试 (Doubao) ==='));
console.log(c.dim(`6场景 × 2条消息 × 3种 directive = 36次调用，model: ${MODEL}\n`));

// 服务匹配关键词（V3.5/V4 用全称，V3 用简称）
const SERVICE_KEYWORDS = [SKILL_NAME, 'AI全维度营养顾问', '营养顾问', '饮食方案服务', '营养方案'];
const mentionedServiceFn = reply => SERVICE_KEYWORDS.some(kw => reply.includes(kw));
const askedConfirmFn     = reply => /是否|要不要|想.*使用|试试|确认/.test(reply);
const pushedAwayFn       = reply => /不需要|已有|不用.*服务|我自己/.test(reply);  // AI 识别到拒绝信号

const allResults = [];

for (const scenario of SCENARIOS) {
  console.log(c.bold(`\n${'═'.repeat(65)}`));
  console.log(c.blue(scenario.label));

  for (const msg of scenario.messages) {
    console.log(c.dim(`\n  用户说：「${msg}」`));

    const msgResults = { scenario: scenario.label, msg, variants: [] };

    for (const v of VARIANTS) {
      const systemPrompt = `${SYSTEM_BASE}\n\n【当前任务指令】\n${v.directive}`;
      process.stdout.write(c.yellow(`  ▶ ${v.label}\n`));
      const reply = await callAI(systemPrompt, msg);
      // 缩进回复便于对比
      const lines = reply.split('\n').map(l => `     ${l}`).join('\n');
      console.log(`${lines}\n`);

      msgResults.variants.push({
        label: v.label,
        mentioned: mentionedServiceFn(reply),
        confirm:   askedConfirmFn(reply),
        pushedAway: pushedAwayFn(reply),
      });
    }
    allResults.push(msgResults);
  }
}

// ── 总结表格 ──────────────────────────────────────────────────────────────────
console.log(c.bold('\n\n=== 总结 ==='));
console.log(c.dim('✅=提及服务  ⚡=要求确认  🚫=被用户拒绝后AI反应\n'));

for (const r of allResults) {
  console.log(c.blue(`${r.scenario}`));
  console.log(c.dim(`  「${r.msg.slice(0,30)}...」`));
  for (const v of r.variants) {
    const m = v.mentioned   ? c.green('✅提及') : c.dim('  未提');
    const k = v.confirm     ? c.yellow('⚡要确认') : '       ';
    const p = v.pushedAway  ? '🚫AI识别拒绝' : '';
    console.log(`  ${v.label.split('】')[0]+']'}\t${m}  ${k}  ${p}`);
  }
  console.log();
}


