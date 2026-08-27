/**
 * agents_factory/src/productPackager.ts
 * 
 * 爆品微商化营销包装引擎 (Product Marketing Packaging Engine)
 * 职责：读取纯客观的产品基础信息 JSON，利用大模型（DeepSeek V4 Flash）
 * 自动提炼、升华并包装为极具微商私域销售力、情绪价值与促单穿透力的「爆款武器库」。
 */

import fs from 'fs';
import path from 'path';

export interface RawProductSpec {
  product_id: string;
  name: string;
  category: string;
  items: Array<{ name: string; volume: string; texture: string }>;
  ingredients: Array<{ name: string; percentage: string; function: string }>;
  target_audience: {
    age_range: string;
    skin_type: string;
    pain_points: string[];
  };
  safety_specs: {
    additives: string[];
    testing: string;
  };
  pricing: {
    official_retail_price: number;
    min_allowed_price: number;
    suggested_gift_items: string[];
  };
  usage_routine: {
    morning: string;
    night: string;
  };
}

export interface PackagedProductArsenal {
  product_id: string;
  name: string;
  nicknames: string[];                 // 响亮的江湖爆款昵称
  one_sentence_slogan: string;         // 一句话穿透痛点的爆款金句
  target_persona: string;              // 精准人群画像与痛点洞察
  ingredient_weaponry: Array<{         // 口语化、高大上的成分背书
    raw_name: string;
    sales_pitch: string;
  }>;
  transformation_timeline: {           // 见证蜕变时间轴
    day_3: string;
    day_7: string;
    day_28: string;
  };
  pricing_and_promotions: {            // 微商逼单与超预期宠粉机制
    retail_price: number;
    special_vip_price: number;
    gift_tier_1: string;               // 拍一套自掏腰包赠品
    gift_tier_2: string;               // 拍两套囤货王炸机制
    scarcity_script: string;           // 抢单与紧迫感话术
  };
  usage_sop_and_care: {                // 保姆级使用手法
    morning_routine: string;
    night_routine: string;
    pro_tip: string;
  };
  retention_and_rebuy: {               // 空瓶复购与锁客政策
    empty_bottle_rebate: string;
    lifecycle_followup: string;
  };
  objection_handling: Array<{          // 高情商异议化解指南
    objection: string;
    high_eq_response: string;
  }>;
}

/** 调用火山引擎 DeepSeek V4 Flash 完成产品微商化包装 */
export async function packageProduct(rawProduct: RawProductSpec): Promise<PackagedProductArsenal> {
  const arkKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  const arkBase = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
  const model = process.env.ARK_MODEL || process.env.DEFAULT_MODEL || 'deepseek-v4-flash-ga-260731';

  if (!arkKey) {
    throw new Error('[ProductPackager] 未配置 ARK_API_KEY 或 DOUBAO_API_KEY');
  }

  const systemPrompt = `你是一位拥有10年经验的顶级护肤品微商操盘手与爆品策划专家。
你的任务是将一份纯客观、死板的产品原材料与基础参数信息，包装提炼成一套极具微商私域销售力、情绪穿透力、姐妹信任感与促单紧迫感的【爆款产品武器库】。

【包装核心原则】：
1. 语言要接地气、有画面感、有温度，像金牌大女主主理人在跟姐妹分享；
2. 成分要口语化升华（如：III型重组胶原蛋白 -> "直达肌底撑起垮脸的软黄金"；麦角硫因 -> "熬夜蜡黄脸的橡皮擦"）；
3. 价格与机制要有极致的微商逼单感（官方标价与VIP宠粉价反差、自掏腰包塞大礼包、扣下库存限量抢）；
4. 售后要有保姆级的专业度（28天代谢周期、空瓶置换返红包、手法SOP）；
5. 异议化解要高情商，不讲生硬大道理，用信任和承诺打消顾虑。

请只输出纯 JSON，符合以下 TypeScript 接口结构，严禁输出任何 Markdown 标记或多余文字：
{
  "product_id": "${rawProduct.product_id}",
  "name": "${rawProduct.name}",
  "nicknames": ["2~3个朗朗上口、极具画面感的江湖爆品昵称"],
  "one_sentence_slogan": "一句话直击30-45岁女性痛点的爆款金句",
  "target_persona": "目标女性真实痛点洞察",
  "ingredient_weaponry": [
    { "raw_name": "原成分名", "sales_pitch": "一句生动形象、高级又懂行的微商口语化背书" }
  ],
  "transformation_timeline": {
    "day_3": "3天肤感变化",
    "day_7": "7天去黄透亮变化",
    "day_28": "28天紧致提拉蜕变"
  },
  "pricing_and_promotions": {
    "retail_price": ${rawProduct.pricing.official_retail_price},
    "special_vip_price": ${rawProduct.pricing.min_allowed_price},
    "gift_tier_1": "拍1套正装，主理人自掏腰包加赠的超预期大礼包详情",
    "gift_tier_2": "拍2套囤货装立减与正装大件赠品机制",
    "scarcity_script": "制造库存紧俏与专属特权的微商逼通话术"
  },
  "usage_sop_and_care": {
    "morning_routine": "早间清爽水光手法",
    "night_routine": "晚间深层提拉修护手法",
    "pro_tip": "1个让护肤效果翻倍的主理人私藏小技巧"
  },
  "retention_and_rebuy": {
    "empty_bottle_rebate": "28天空瓶拍照打卡返红包与特权机制",
    "lifecycle_followup": "按用量周期的贴心回访策略"
  },
  "objection_handling": [
    {
      "objection": "你能承诺100%有效吗？/真的有用吗？",
      "high_eq_response": "不夸大吹嘘但底气十足、让客户极度安心的高情商回答"
    },
    {
      "objection": "价格能不能再便宜点？",
      "high_eq_response": "守住底价但用赠品和情绪价值让客户觉得占大便宜的回答"
    },
    {
      "objection": "我是敏感肌/换季容易泛红，可以用吗？",
      "high_eq_response": "专业安全背书与保姆级陪跑承诺"
    }
  ]
}`;

  const userPrompt = `请基于以下客观产品基础信息，完成顶级微商化爆品营销包装：\n\n${JSON.stringify(rawProduct, null, 2)}`;

  console.log(`[ProductPackager] 🚀 开始使用 ${model} 包装产品: ${rawProduct.name}...`);
  const res = await fetch(`${arkBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${arkKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    throw new Error(`[ProductPackager] HTTP ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  const cleaned = rawContent.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
  const packaged = JSON.parse(cleaned) as PackagedProductArsenal;

  console.log(`[ProductPackager] ✅ 产品包装完成！江湖昵称: ${packaged.nicknames.join(', ')}`);
  return packaged;
}

// ── CLI 测试运行入口 ──
if (require.main === module) {
  (async () => {
    const rawPath = path.join(__dirname, '..', 'products', 'collagen_repair_set.json');
    if (!fs.existsSync(rawPath)) {
      console.error('未找到原始产品文件:', rawPath);
      process.exit(1);
    }
    const rawProduct = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    const packaged = await packageProduct(rawProduct);

    const outDir = path.join(__dirname, '..', 'packaged_products');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${rawProduct.product_id}_packaged.json`);
    fs.writeFileSync(outPath, JSON.stringify(packaged, null, 2), 'utf-8');
    console.log(`[ProductPackager] 💾 包装成果已保存: ${outPath}`);
  })();
}
