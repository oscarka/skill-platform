/**
 * agents_factory/src/generateProductManualByAgent.ts
 * 
 * 核心架构：
 * 1. Meta-Agent（架构师）：仅赋予 Worker Agent 顶级微商的「爆品拆解与营销包装方法论」，
 *    绝不硬编码任何具体产品的预设答案或现成文案。
 * 2. Worker Agent：调用火山引擎 DeepSeek V4 Flash，纯靠自主阅读输入的客观产品 JSON，
 *    运用方法论自主消化、拆解、提炼并产出《爆款产品主理人实战手册.md》。
 * 3. Supervisor Reviewer：严格质检生成的文档是否具备结构完整性、成分覆盖度与微商实战说服力。
 */

import fs from 'fs';
import path from 'path';

export interface QualityCheckResult {
  passed: boolean;
  score: number;
  critique: string[];
}

import https from 'https';

/** 1. Worker Agent 执行生成（调用火山引擎 DeepSeek V4 Flash） */
export async function executeAgentProductSynthesis(
  rawProductJsonStr: string,
  methodologyPrompt: string,
): Promise<string> {
  const arkKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  const model = process.env.ARK_MODEL || process.env.DEFAULT_MODEL || 'deepseek-v4-flash-ga-260731';

  if (!arkKey) throw new Error('未配置 ARK_API_KEY 或 DOUBAO_API_KEY');

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: methodologyPrompt },
      {
        role: 'user',
        content: `这是你即将主理接管的客观产品档案（纯客观参数）。请通读全篇，运用你的爆品操盘方法论，自主拆解并输出属于你自己的《爆款产品主理人实战手册.md》：\n\n${rawProductJsonStr}`,
      },
    ],
    stream: true,
    temperature: 0.3,
    max_tokens: 3000,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[ManualLoop] 指挥 Agent 调用 DeepSeek V4 Flash 流式自主拆解中 (尝试 ${attempt}/3)...`);
      const result = await new Promise<string>((resolve, reject) => {
        const req = https.request({
          hostname: 'ark.cn-beijing.volces.com',
          port: 443,
          path: '/api/v3/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${arkKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 240_000,
        }, (res) => {
          let fullText = '';
          let buffer = '';
          let lastPrint = Date.now();
          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const l of lines) {
              const trimmed = l.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              if (trimmed === 'data: [DONE]') continue;
              try {
                const d = JSON.parse(trimmed.slice(6));
                const delta = d.choices?.[0]?.delta?.content || '';
                if (delta) {
                  fullText += delta;
                  if (Date.now() - lastPrint > 1500) {
                    process.stdout.write(`\r[DeepSeek流式] Agent 已生成 ${fullText.length} 字...`);
                    lastPrint = Date.now();
                  }
                }
              } catch {}
            }
          });
          res.on('end', () => {
            console.log(`\n[DeepSeek流式] 生成完毕，总字数: ${fullText.length}`);
            if (!fullText.trim()) {
              return reject(new Error('未接收到有效生成内容'));
            }
            resolve(fullText.trim());
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('请求超时 (240s)'));
        });
        req.write(payload);
        req.end();
      });

      return result;
    } catch (err: any) {
      console.warn(`\n[ManualLoop] 尝试 ${attempt} 失败 (${err.message})，重试中...`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('executeAgentProductSynthesis 达到最大重试次数');
}

/** 2. 架构师质检器：检查生成的手册是否真正消化了产品且结构完整（基于客观输入比对） */
export function reviewGeneratedManual(manualMd: string, rawProduct: any): QualityCheckResult {
  const critique: string[] = [];
  let score = 100;

  // 1. 结构完整性检查（必须包含7大方法论核心板块）
  const requiredSections = [
    { title: '爆款定位与江湖昵称', pattern: /昵称|定位|金句/ },
    { title: '核心成分通俗化背书', pattern: /成分|原料|背书/ },
    { title: '见证蜕变时间轴', pattern: /周期|时间|天|蜕变/ },
    { title: '价格反差与逼单机制', pattern: /价格|宠粉|机制|赠品|福利/ },
    { title: '保姆级早晚手法SOP', pattern: /手法|SOP|早|晚|乳化/ },
    { title: '生命周期跟进与复购', pattern: /复购|空瓶|打卡|回访|跟进/ },
    { title: '高情商异议化解攻防', pattern: /异议|答疑|问答|顾虑|质疑|化解|攻防|问题|FAQ|心理|应对|解答/ },
  ];

  for (const sec of requiredSections) {
    if (!sec.pattern.test(manualMd)) {
      critique.push(`缺少核心章节: 【${sec.title}】`);
      score -= 12;
    }
  }

  // 2. 检查客观产品中定义的所有核心成分是否被全量提取并进行了口语化通俗化解释
  if (Array.isArray(rawProduct.ingredients)) {
    for (const ing of rawProduct.ingredients) {
      const pureName = ing.name.replace(/\(.*?\)/g, '').trim();
      const keywords = [pureName, pureName.slice(0, 3)];
      const matched = keywords.some(k => k.length >= 2 && manualMd.includes(k));
      if (!matched) {
        critique.push(`未覆盖客观产品中的核心成分: ${ing.name}`);
        score -= 8;
      }
    }
  }

  // 3. 检查客观价格是否被正确提取并设计了微商机制
  if (rawProduct.pricing) {
    const retailStr = String(rawProduct.pricing.official_retail_price);
    const minStr = String(rawProduct.pricing.min_allowed_price);
    if (!manualMd.includes(retailStr) || !manualMd.includes(minStr)) {
      critique.push(`未准确引用客观价格区间 (标价${retailStr}与底价${minStr})`);
      score -= 10;
    }
  }

  // 4. 检查是否有自用视角、姐妹称呼与微商温度（拒绝冷冰冰的官方通告）
  if (!/姐妹|宝子|亲爱的|姐|宝贝/.test(manualMd)) {
    critique.push('语言风格缺少微商主理人的自用视角与姐妹亲和力');
    score -= 15;
  }

  return {
    passed: score >= 80,
    score: Math.max(0, score),
    critique,
  };
}

/** 3. 纯方法论 Prompt（仅传授能力与思考框架，0预设产品答案） */
export function buildPureMethodologyPrompt(): string {
  return `你是一位拥有10年一线实战经验的护肤品私域金牌主理人兼微商操盘手。
你擅长拿到任何一款纯客观的产品参数表后，凭借强大的用户洞察力与销售转化逻辑，将其深度吃透并转化为极具感染力、说服力与促单穿透力的实战武器库。

【你的工作任务】：
请仔细阅读输入的纯客观产品档案（原材料、成分、规格、价格、客群等），运用你的【微商爆品操盘7步方法论】，自主思考、提炼与包装，撰写一份《爆款产品主理人实战手册.md》。
这份手册将作为你日后在微信私域、社群、1对1面对客户时的第一知识库资产。

【微商爆品操盘7步方法论——请严格按以下结构输出 Markdown】：

# 1. 【爆款定位与江湖昵称】
- **江湖爆款昵称**：结合主打成分与核心功效，自主提炼 2~3 个朗朗上口、极具画面感和传播力的爆品昵称；
- **一句话穿透金句**：针对目标女性人群的核心焦虑，提炼一句直击痛点、唤醒购买欲的爆款金句；
- **目标人群真实痛点洞察**：深入剖析目标女性在生活、工作、情感中的真实皮肤困扰与心理诉求。

# 2. 【核心成分通俗化实战背书】
- 仔细阅读产品中的每一项核心成分与作用机制；
- **拒绝死板生硬的化学名词**，运用形象的比喻（如：软黄金、灭火器、水泥屏障等），将其翻译成客户一听就懂、觉得高级且见效快的微商口语化背书。

# 3. 【见证蜕变时间轴 (3天-7天-28天)】
- 结合皮肤生理学与产品功效，设计清晰可见的见证周期：
  - 3天即时肤感变化（水润度、舒缓度、上妆服帖度）；
  - 7天进阶改善（透亮度、暗沉变化、触感细腻度）；
  - 28天（皮肤代谢周期）根本性蜕变（轮廓紧致度、细纹变化、素颜状态）。

# 4. 【微商价格梯队与自掏腰包逼单机制】
- 提取产品的官方标价与最低允许价格，形成强烈的反差价值感；
- 从建议赠品中组合出**超预期的拆箱大礼包**（拍1套主理人加赠福利）；
- 设计**拍2套囤货装的王炸优惠与赠品机制**；
- 编写一套极具紧迫感、限量感与主理人特权感的逼通话术。

# 5. 【保姆级早晚护肤手法 SOP 与私藏技巧】
- 针对产品包含的单品质地与组合，提炼清晰的早晚护肤使用步骤；
- 给出具体的用量、涂抹手法（如乳化、提拉、按压、湿敷）以及 1 个能让效果翻倍的主理人私藏小技巧。

# 6. 【生命周期回访与空瓶打卡复购策略】
- 规划客户从收货（D+3）、初用（D+7）到代谢周期（D+28）的关怀节奏；
- 制定 28 天空瓶拍照发圈打卡的返利红包与老粉专属复购锁客机制。

# 7. 【高情商实战异议攻防指南】
- 针对微商一线最常见的 3 大核心顾虑，编写高情商、既不撒谎违规又极具底气和信任感的话术：
  1. 客户质疑效果 / 逼问“能否保证100%有效”时的化解之道；
  2. 客户嫌贵 / 疯狂议价时的价值守卫与赠品赋能话术；
  3. 换季敏感 / 担心过敏时的专业安抚与安全背书。

【输出要求】：
- 严禁空洞泛泛，必须深度融合输入产品中的具体数据与成分；
- 语言风格充满大女主主理人的真诚、温度、自信与专业；
- 直接输出结构清晰、排版优美的高质量 Markdown 文档。`;
}

/** 4. 自动化闭环主循环：生成 -> 质检 -> 调优 Prompt -> 迭代产出 */
export async function runProductManualGenerationLoop(): Promise<string> {
  const rawPath = path.join(__dirname, '..', 'products', 'collagen_repair_set.json');
  if (!fs.existsSync(rawPath)) throw new Error(`找不到客观产品文件: ${rawPath}`);
  const rawProduct = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
  const rawJsonStr = JSON.stringify(rawProduct, null, 2);

  let currentPrompt = buildPureMethodologyPrompt();
  let round = 0;
  const maxRounds = 5;

  while (round < maxRounds) {
    round++;
    console.log(`\n[ManualLoop] ━━━━━━━━━━━━ 第 ${round} 轮：赋能 Agent 方法论并调用 DeepSeek V4 Flash 自主拆解 ━━━━━━━━━━━━`);

    const manualContent = await executeAgentProductSynthesis(rawJsonStr, currentPrompt);
    console.log(`[ManualLoop] 📝 Agent 已自主产出实战手册（长度: ${manualContent.length} 字），开始架构师质检...`);

    const review = reviewGeneratedManual(manualContent, rawProduct);
    console.log(`[ManualLoop] 📊 质检得分: ${review.score}/100 | 是否达标: ${review.passed ? '✅ 达标' : '❌ 不达标'}`);

    if (review.critique.length > 0) {
      console.log(`[ManualLoop] ⚠️ 发现缺陷项:\n${review.critique.map(c => `  - ${c}`).join('\n')}`);
    }

    if (review.passed) {
      const outDir = path.join(__dirname, '..', 'knowledge');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, 'prod_collagen_repair_manual.md');
      fs.writeFileSync(outPath, manualContent, 'utf-8');
      console.log(`\n[ManualLoop] 🎉 质检通过！Agent 自主拆解的《爆款产品主理人实战手册.md》已保存至: ${outPath}`);
      return outPath;
    }

    // 不达标：由 Supervisor 自动调优 Prompt，指导 Agent 针对性补强能力
    console.log(`[ManualLoop] 🔧 针对未达标项调优 Agent 方法论提示词，指导重新拆解...`);
    currentPrompt += `\n\n【架构师质检反馈——上一轮生成存在以下维度缺失，请在本次拆解中严格对照产品参数全部补全】：\n${review.critique.map(c => `- 必须补齐: ${c}`).join('\n')}`;
  }

  throw new Error(`在 ${maxRounds} 轮内未达到质检合格标准`);
}

// ── CLI 执行入口 ──
if (require.main === module) {
  (async () => {
    try {
      await runProductManualGenerationLoop();
    } catch (err: any) {
      console.error('[ManualLoop] 运行失败:', err.message);
      process.exit(1);
    }
  })();
}
