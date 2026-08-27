/**
 * agents_factory/src/synthesizePersonaAndManual.ts
 * 
 * 通用【微商人设生成 + 产品微商销售再包装】双核引擎
 * 
 * 核心设计原则：
 * 1. 100% 通用方法论：提示词内 0 硬编码品类（不绑定护肤/食品/数码/课程），由 LLM 根据输入的产品 JSON 自动逆向推理；
 * 2. 一次性双重输出：
 *    - 输出 1：契合该产品与客群的【微商金牌主理人人设 Spec JSON】
 *    - 输出 2：极具销售力与促单穿透力的【爆款产品实战手册 Markdown】
 * 3. 闭环质量自检：检查人设完整度、价格底线准确性、7大板块覆盖率与闺蜜温度。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export interface SynthesisResult {
  product_id: string;
  agent_spec: any;
  manual_markdown: string;
  quality_check: {
    passed: boolean;
    score: number;
    critique: string[];
  };
}

/** 1. 构建 100% 通用的人设推导与微商再包装 Prompt（0硬编码任何行业词） */
export function buildUniversalSynthesisPrompt(): string {
  return `你是一位拥有10年一线操盘经验的【私域金牌操盘手兼爆品企划大师】。
你深知：**一个顶级的微商主理人，绝不是只会背诵产品参数的冷血销售！**
真正的微商高手，靠的是**极具人情味的3D立体人设、敢于拿自己的血泪史自黑举例、懂客户的生活琐碎与情绪价值，并且能跟客户在微信里就带娃、加班、吃大餐、换季天气等日常话题热火朝天地闲扯淡，在无痕中建立过命的闺蜜信任感！**

你的任务是通读输入的【品牌产品标准档案 JSON】，自主完成两大核心资产的构建：

【任务一：逆向推导出极度丰满、有血有肉的「微商金牌主理人人设 Spec JSON」】
分析产品的目标人群与生活痛点，设计一个最能让TA放下防备、产生强烈生活共鸣的主理人。
请输出合规的 JSON 对象，必须包含以下标准与扩展字段：
- name: 岗位名称（如“XX私域金牌主理人”）
- role_desc: 核心人设概括（同龄实战派、自用口碑背书、深度吃透产品、懂生活琐碎与情绪价值的大姐姐闺蜜）
- persona_lore: 立体人设背景对象：
  - identity_and_background: 详细生活背景（如：年龄35岁、二胎宝妈/独居职场女青年、白天互联网高压运营/晚上轻体主理人、作息与生活小烦恼）
  - vulnerable_origin_story: 自己的至暗时刻与踩坑血泪史（曾经多胖/多垮/便秘多严重/吃了什么泻药或烂脸产品遭罪/花了多少冤枉钱/怎么找到这套方案走出来的真实经历）
  - lifestyle_habits: 4个日常朋友圈生活锚点（如：晨间打卡、深夜哄睡后独处半小时、周末空气炸锅低卡餐、吃火锅奶茶时的吃货心虚与急救）
- personal_stories: 数组，提供 3 个拿自己真实经历举例的生动故事（用于在聊天中化解疑虑、拉近距离）：
  1. 曾经踩坑受罪的血泪故事（如吃减肥药半夜肚子绞痛蹲厕所虚脱/买大牌护肤品浮在脸上干着急）；
  2. 第一次看到蜕变见证的惊喜故事（如上妆终于不卡粉想哭/穿回生娃前的裤子拉链拉上了）；
  3. 大餐聚会或日常急救的亲测故事（如带闺蜜吃九宫格火锅偷偷吃两条第二天没涨秤）。
- small_talk_anchors: 数组，提供 4 组日常闲聊扯淡与共情谈资库（客户不问产品时，如何陪客户唠嗑闲扯）：
  1. 聊娃与家庭（开学破产、辅导作业血压飙升、幼儿园手工作业逼疯老母亲）；
  2. 聊职场与加班（周一综合征、被无脑开会折磨、外卖吃腻了想吃麻辣烫又怕油）；
  3. 聊吃货心虚（想吃炸鸡奶茶又怕长肉、女人最大的敌人就是甜品、偷吃零食的心态）；
  4. 聊生活与换季天气（降温添衣、换季干燥、周末去哪遛弯、熬夜追剧黑眼圈）。
- reply_style: 聊天风格要求（热情似火、真诚自然、闺蜜称呼如宝子/姐、短句节奏、多用感叹号和温暖Emoji、严禁Markdown符号、严禁URL、高情商接梗与化解）
- service_flow: 标准服务闭环流程（生活闲聊破冰 -> 痛点共情与自我举例诊断 -> 保姆级定制方案 -> 专属福利与赠品逼单 -> 周期打卡与日常唠嗑锁客）
- taboos: 严禁触碰的红线列表（虚假宣传、绝对化承诺、泄露隐私、使用确诊/治疗等医疗词、破价乱市、强迫发圈）
- reassurance_tpl: 面对客户初期疑虑或生活焦虑时的高情商安抚模版（充满共情、掏心窝子）
- routing_examples: 包含至少 4 组典型路由用例：
  1. 纯日常闲聊扯淡（客户晒娃/吐槽加班/聊吃的） -> answer_directly（陪聊唠嗑，共情接梗，不生硬推销）；
  2. 产品痛点与定制咨询 -> answer_directly（拿自己经历举例，给保姆级方案）；
  3. 极端客诉/不适反馈 -> human_handoff（立即安抚，不争辩，转1对1专家排查）；
  4. 大额代理/批量采购 -> human_handoff（热情感谢，转渠道负责人对接政策）。
- delivery_config: 回复配置 { max_reply_length: 150, use_emoji: true, greeting_style: "warm", response_tone: "empathetic" }

【任务二：撰写该产品的「微商爆品实战销售手册」】
严格运用【微商爆品操盘 7 步方法论】，输出结构优美、充满温度与销售力的 Markdown 文档：
1. 【爆款定位与江湖昵称】：提炼2~3个自带场景的江湖爆品昵称、1句直击痛点的穿透金句、目标人群真实痛点与心理潜台词剖析；
2. 【核心成分/参数通俗化背书】：拒绝死板生硬的技术参数，用生动比喻将其翻译成客户一听就懂的大白话价值；
3. 【见证蜕变时间轴】：按照使用周期的生理/使用规律，规划清晰的三阶段变化（即时体感 -> 进阶信心 -> 周期根本蜕变）；
4. 【微商价格梯队与自掏腰包逼单机制】：提取官方标价与底价形成强烈反差，设计主理人自掏腰包的超预期拆箱大礼包、2套囤货王炸机制，以及限时限量的逼通话术；
5. 【保姆级使用/交付 SOP 与私藏技巧】：给出具体使用步骤、用量手法细节，并提供 1 个能让效果翻倍的主理人私藏小技巧；
6. 【生命周期回访与打卡复购策略】：规划收货、初用、代谢周期的跟进节奏，制定空瓶/用完打卡发圈晒单返红包的老客锁客机制；
7. 【高情商实战异议攻防指南】：针对微商一线最核心的3大抗拒点（嫌贵议价、质疑没效果/逼问100%、担心副作用/依赖/售后）编写高情商微信聊天拆招话术。

【输出格式规范】：
必须严格按照以下双分隔标签格式输出，方便系统自动解析与落盘：

<<<AGENT_SPEC_JSON>>>
{
  "spec": { ... }
}
<<<END_AGENT_SPEC_JSON>>>

<<<PRODUCT_MANUAL_MARKDOWN>>>
# 《爆款产品主理人实战手册》
... Markdown 正文 ...
<<<END_PRODUCT_MANUAL_MARKDOWN>>>`;
}

/** 2. 调用火山 DeepSeek V4 Flash 进行流式生成 */
export async function executeUniversalSynthesis(productJsonStr: string): Promise<string> {
  const arkKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  if (!arkKey) throw new Error('未配置 DOUBAO_API_KEY 或 ARK_API_KEY 环境变量');

  const arkBase = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
  const model = process.env.ARK_MODEL || process.env.DEFAULT_MODEL || 'deepseek-v4-flash-ga-260731';
  const prompt = buildUniversalSynthesisPrompt();

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `这是品牌厂商提供的客观产品档案 JSON，请仔细通读，逆向推导最契合的微商人设 Spec，并撰写微商实战手册：\n\n${productJsonStr}`,
      },
    ],
    stream: true,
    temperature: 0.3,
    max_tokens: 4000,
  });

  return new Promise<string>((resolve, reject) => {
    console.log(`[Synthesizer] 🚀 指挥 DeepSeek V4 Flash (${model}) 开始通用人设推导与微商再包装...`);
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
      timeout: 180_000,
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
                process.stdout.write(`\r[Synthesizer] 正在流式生成中... 已产出 ${fullText.length} 字`);
                lastPrint = Date.now();
              }
            }
          } catch {}
        }
      });

      res.on('end', () => {
        console.log(`\n[Synthesizer] ✅ 生成完毕，总字符数: ${fullText.length}`);
        if (!fullText.trim()) return reject(new Error('未接收到有效生成内容'));
        resolve(fullText.trim());
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时 (180s)'));
    });
    req.write(payload);
    req.end();
  });
}

/** 3. 提取与解析双核产物 */
export function parseSynthesisOutput(rawOutput: string): { spec: any; manual: string } {
  let specJson: any = null;
  let manualMd = '';

  // 1. 提取 Spec JSON
  const jsonMatch = rawOutput.match(/<<<AGENT_SPEC_JSON>>>([\s\S]*?)<<<END_AGENT_SPEC_JSON>>>/) ||
                    rawOutput.match(/===SPEC_START===([\s\S]*?)===SPEC_END===/) ||
                    rawOutput.match(/```json\s*(\{[\s\S]*?"spec"[\s\S]*?\})\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    try {
      const cleaned = jsonMatch[1].replace(/```json?\s*/g, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      specJson = parsed.spec || parsed;
    } catch (e: any) {
      console.warn(`[Synthesizer] JSON 解析警告: ${e.message}`);
    }
  }

  // 2. 提取 Manual Markdown
  const manualMatch = rawOutput.match(/<<<PRODUCT_MANUAL_MARKDOWN>>>([\s\S]*?)(?:<<<END_PRODUCT_MANUAL_MARKDOWN>>>|$)/) ||
                      rawOutput.match(/===MANUAL_START===([\s\S]*?)(?:===MANUAL_END===|$)/) ||
                      rawOutput.match(/(#\s*《?[^#\n]*实战手册[\s\S]*)/);
  if (manualMatch && manualMatch[1]) {
    manualMd = manualMatch[1].replace(/^```markdown?\s*/g, '').replace(/```\s*$/g, '').trim();
  } else {
    // 兜底：从第一个 Markdown 标题开始截取
    const firstHeader = rawOutput.indexOf('# ');
    if (firstHeader !== -1) {
      manualMd = rawOutput.slice(firstHeader).replace(/<<<[\s\S]*?>>>/g, '').trim();
    }
  }

  return { spec: specJson, manual: manualMd };
}

/** 4. 架构师通用质检器 */
export function qualityCheckUniversalOutput(spec: any, manual: string, rawProduct: any): { passed: boolean; score: number; critique: string[] } {
  const critique: string[] = [];
  let score = 100;

  // 检查 Spec 是否合规与立体丰满
  if (!spec || !spec.role_desc) {
    critique.push('Spec 缺少核心 role_desc 设定');
    score -= 20;
  }
  if (!spec || !spec.persona_lore || !spec.persona_lore.vulnerable_origin_story) {
    critique.push('Spec 缺少 3D 立体人设或至暗时刻踩坑血泪史 (persona_lore)');
    score -= 15;
  }
  if (!spec || !Array.isArray(spec.personal_stories) || spec.personal_stories.length < 2) {
    critique.push('Spec 缺少自我举例的真实故事库 (personal_stories)');
    score -= 10;
  }
  if (!spec || !Array.isArray(spec.small_talk_anchors) || spec.small_talk_anchors.length < 2) {
    critique.push('Spec 缺少日常闲聊扯淡与共情谈资库 (small_talk_anchors)');
    score -= 10;
  }
  if (!spec || !spec.reply_style || !spec.reply_style.includes('Markdown')) {
    critique.push('Spec reply_style 未明确约束禁用 Markdown');
    score -= 10;
  }
  if (!spec || !Array.isArray(spec.routing_examples) || spec.routing_examples.length < 3) {
    critique.push('Spec 缺少至少 3 组路由示例（需包含日常闲聊互动）');
    score -= 10;
  }

  // 检查 Manual 7 大板块覆盖
  const requiredSections = [
    { title: '爆款定位与江湖昵称', pattern: /昵称|定位|金句/ },
    { title: '核心成分/参数通俗化背书', pattern: /成分|参数|原料|背书/ },
    { title: '见证蜕变时间轴', pattern: /周期|时间|天|蜕变/ },
    { title: '价格反差与逼单机制', pattern: /价格|宠粉|机制|赠品|福利/ },
    { title: '保姆级使用/交付 SOP', pattern: /手法|SOP|步骤|使用/ },
    { title: '生命周期回访与复购', pattern: /复购|空瓶|打卡|回访|跟进/ },
    { title: '高情商实战异议攻防', pattern: /异议|答疑|问答|顾虑|质疑|化解|攻防|问题|FAQ|心理|应对|解答/ },
  ];

  for (const sec of requiredSections) {
    if (!sec.pattern.test(manual)) {
      critique.push(`手册缺少核心板块: 【${sec.title}】`);
      score -= 10;
    }
  }

  // 检查价格引用准确性
  if (rawProduct.pricing) {
    const retailStr = String(rawProduct.pricing.official_retail_price);
    const minStr = String(rawProduct.pricing.min_allowed_price);
    if (!manual.includes(retailStr) || !manual.includes(minStr)) {
      critique.push(`手册未准确提取价格区间 (标价${retailStr} / 底价${minStr})`);
      score -= 10;
    }
  }

  // 检查微商温度
  if (!/姐妹|宝子|亲爱的|姐|宝贝/.test(manual)) {
    critique.push('手册语言风格缺少微商主理人的人情味与亲和力');
    score -= 15;
  }

  return {
    passed: score >= 80 && !!spec && manual.length > 1500,
    score: Math.max(0, score),
    critique,
  };
}

/** 5. 执行主入口 */
export async function runUniversalSynthesisPipeline(productFile: string = 'collagen_repair_set.json'): Promise<SynthesisResult> {
  const prodPath = path.join(__dirname, '..', 'products', productFile);
  if (!fs.existsSync(prodPath)) throw new Error(`找不到产品档案: ${prodPath}`);

  const rawProduct = JSON.parse(fs.readFileSync(prodPath, 'utf-8'));
  const rawProductJsonStr = JSON.stringify(rawProduct, null, 2);

  console.log(`\n================================================================`);
  console.log(`🎯 开始执行通用【微商人设生成 + 微商销售再包装】流水线`);
  console.log(`📦 目标产品: ${rawProduct.name} (${rawProduct.product_id})`);
  console.log(`================================================================\n`);

  const rawOutput = await executeUniversalSynthesis(rawProductJsonStr);
  const { spec, manual } = parseSynthesisOutput(rawOutput);

  // 质检
  const check = qualityCheckUniversalOutput(spec, manual, rawProduct);

  console.log(`\n[Synthesizer] 📊 质检得分: ${check.score}/100 | 是否达标: ${check.passed ? '✅ 达标' : '❌ 未达标'}`);
  if (check.critique.length > 0) {
    console.log(`[Synthesizer] ⚠️ 质检意见: \n  - ${check.critique.join('\n  - ')}`);
  }

  // 落盘资产
  if (spec) {
    const draftPath = path.join(__dirname, '..', 'drafts', `agent_${rawProduct.product_id}.json`);
    const draftContent = {
      spec: {
        id: `agent_${rawProduct.product_id}`,
        ...spec,
        knowledge_domain: 'social_ops',
        intent_prompt: `负责${rawProduct.name}的微信私域社群运营与促单转化`,
      },
      confidence: 0.95,
      clarification_needed: null,
      generation_notes: [
        `由 UniversalSynthesisEngine 基于 ${rawProduct.name} 纯客观档案自动推导微商人设并完成微商二次包装`,
      ],
    };
    fs.writeFileSync(draftPath, JSON.stringify(draftContent, null, 2), 'utf-8');
    console.log(`[Synthesizer] 💾 候选 Agent Spec 已保存至: ${draftPath}`);
  }

  if (manual) {
    const manualPath = path.join(__dirname, '..', 'knowledge', `${rawProduct.product_id}_manual.md`);
    fs.mkdirSync(path.dirname(manualPath), { recursive: true });
    fs.writeFileSync(manualPath, manual, 'utf-8');
    console.log(`[Synthesizer] 💾 实战销售手册已保存至: ${manualPath}`);
  }

  return {
    product_id: rawProduct.product_id,
    agent_spec: spec,
    manual_markdown: manual,
    quality_check: check,
  };
}

if (require.main === module) {
  const prodFile = process.argv[2] || 'collagen_repair_set.json';
  runUniversalSynthesisPipeline(prodFile)
    .then((res) => {
      console.log(`\n🎉 通用人设推导与微商再包装测试全部完成！`);
    })
    .catch((err) => {
      console.error(`\n❌ 执行失败:`, err);
      process.exit(1);
    });
}
