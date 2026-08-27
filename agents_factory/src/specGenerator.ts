/**
 * agents_factory/src/specGenerator.ts
 *
 * Phase 4 — 自然语言 → AgentSpec 生成器
 *
 * 功能：
 *   - 输入：一句自然语言招聘需求（如"招一个私域群运营员工"）
 *   - 输出：完整的 MetaAgentSpec（可直接 POST 到 /api/v1/meta/agents）
 *
 * 设计原则：
 *   - 生成结果必须可验证（JSON Schema 校验），不允许空字段
 *   - 禁忌列表（taboos）必须包含领域基线禁忌，LLM 可扩展但不可覆盖
 *   - 提示词只产出"画像"，不将业务知识直接硬写进 reply_style（防止过拟合）
 *   - 每次生成都附带置信度评估，低置信度时触发澄清追问
 */

import * as crypto from 'crypto';
import * as https from 'https';
import { listAvailableSkills } from './apiClient';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface MetaAgentSpec {
  id: string;
  name: string;
  role_desc: string;        // 职位描述（是什么、做什么）
  persona_lore?: {          // 3D 立体人设背景（针对客户侧/私域销售类）
    identity_and_background?: string;
    vulnerable_origin_story?: string;
    lifestyle_habits?: string[];
  };
  personal_stories?: string[];  // 拿自己真实经历举例的故事库
  small_talk_anchors?: string[]; // 日常闲聊扯淡与共情谈资库
  reply_style: string;      // 回复风格约束（字数、语气、禁止格式）
  service_flow: string;     // 服务流程（简洁动词序列，不超过6步）
  taboos: string[];         // 零容忍禁忌（基线 + 领域扩展）
  reassurance_tpl: string;  // 安抚话术模板（用户情绪激动时）
  skill_ids: string[];      // 关联技能 ID 列表
  routing_examples: RoutingExample[];
  delivery_config: DeliveryConfig;
  knowledge_domain: string; // 对应 generic_wiki Domain
  intent_prompt: string;    // 原始用户意图（原文保留，供溯源）
}

export interface RoutingExample {
  user_says: string;
  route_to: string;  // skill_id 或 'human_handoff' 或 'answer_directly'
  reason: string;
}

export interface DeliveryConfig {
  max_reply_length: number;
  use_emoji: boolean;
  greeting_style: 'formal' | 'casual' | 'warm';
  response_tone: 'professional' | 'friendly' | 'empathetic';
}

export interface SpecGenResult {
  spec: MetaAgentSpec;
  confidence: number;        // 0~1
  clarification_needed: string | null;  // 若需要追问，此处非空
  generation_notes: string[];  // 生成过程中的注意点
}

// ─── 领域基线禁忌（无论 LLM 生成什么，这些都要保留）────────────────────────

const BASELINE_TABOOS = [
  '虚假宣传',
  '过度承诺',
  '泄露用户信息',
  '自行生成URL或链接',
  '使用Markdown格式（**加粗**、##标题、- 列表）',
];

// ─── 领域→Wiki Domain 映射 ──────────────────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string> = {
  '群运营': 'social_ops',
  '私域': 'social_ops',
  '社群': 'social_ops',
  '微商': 'social_ops',
  '主理人': 'social_ops',
  '运营': 'social_ops',
  '销售': 'sales',
  '商务': 'sales',
  '客户': 'sales',
  '招聘': 'hr_recruiting',
  '面试': 'hr_recruiting',
  'HR': 'hr_recruiting',
  '健康': 'health',
  '医疗': 'health',
  '患者': 'health',
};

function inferKnowledgeDomain(intent: string): string {
  for (const [keyword, domain] of Object.entries(DOMAIN_KEYWORDS)) {
    if (intent.includes(keyword)) return domain;
  }
  return 'social_ops'; // 默认
}

function generateAgentId(name: string): string {
  // 只保留 ASCII 小写字母、数字，其余字符转为拼音或哈希以符合 ^[a-z0-9_-]{3,64}$
  const asciiSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
  const nameHash = crypto.createHash('md5').update(name).digest('hex').slice(0, 6);
  const suffix = crypto.randomBytes(3).toString('hex');
  const base = asciiSlug ? `${asciiSlug}_${nameHash}` : nameHash;
  return `agent_${base}_${suffix}`.slice(0, 48);
}

// ─── LLM 调用（通过环境变量配置，兼容 Doubao / DeepSeek / Gemini）────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  const model = process.env.SPEC_GEN_MODEL || process.env.ARK_MODEL || process.env.DEFAULT_MODEL || 'deepseek-v4-flash-ga-260731';

  if (!apiKey) {
    throw new Error('[SpecGen] 未配置 LLM API Key（需要 DOUBAO_API_KEY 或 ARK_API_KEY）');
  }

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    temperature: 0.3,
    max_tokens: 4000,
  });

  return new Promise<string>((resolve, reject) => {
    const req = https.request({
      hostname: 'ark.cn-beijing.volces.com',
      port: 443,
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
              if (Date.now() - lastPrint > 1200) {
                process.stdout.write(`\r[SpecGen] HR Agent 正在生成画像中... 已产出 ${fullText.length} 字`);
                lastPrint = Date.now();
              }
            }
          } catch {}
        }
      });

      res.on('end', () => {
        console.log(`\n[SpecGen] ✅ 画像生成完毕，总字符数: ${fullText.length}`);
        if (!fullText.trim()) return reject(new Error('[SpecGen] 未接收到有效画像内容'));
        resolve(fullText.trim());
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('[SpecGen] 请求超时 (180s)'));
    });
    req.write(payload);
    req.end();
  });
}

// ─── Spec 生成提示词 ──────────────────────────────────────────────────────────

function buildSpecGenSystemPrompt(availableSkillsDesc: string): string {
  return `你是一位专业严谨的高级 AI 招聘主管与人才架构专家（Enterprise HR Director & Talent Architect）。
你的内部职责是精准理解业务负责人的“招聘意图”，并自动转化设计出结构化、高质量的「AI 员工画像配置 Spec JSON」。

【核心招聘原则】
1. **区分岗位类型（内部员工 vs 客户侧员工）**：
   - **对于面向 C 端/私域/微商/销售/客户运营岗位**：人是有厚度和温度的，必须赋予其 **3D 立体丰满人设**（生活背景、踩坑血泪史、自我举例故事库、日常闲聊谈资库），坚决不做只会念参数的冷血复读机！
   - **对于内部工具/技术/分析岗位**：保持专业、严谨、客观、高效的工具画像。
2. **reply_style 规范**：对客户侧员工要求口语化、真诚短句、闺蜜亲切称呼、严禁任何 Markdown 语法（无**加粗**、无#标题、无-列表）、严禁输出 URL。
3. **service_flow 规范**：包含日常闲聊破冰、痛点共情与自我举例、保姆级方案、逼单与打卡复购等闭环步骤（不超过6步）。
4. **taboos 是零容忍红线**：虚假宣传、绝对化承诺（保证100%）、泄露隐私、使用确诊/治疗等医疗词汇。
5. **routing_examples 覆盖全场景**：必须包含日常生活闲聊扯淡、业务咨询直答、极端客诉转人工、大额代理转渠道总监等典型用例。

【可用技能列表】
${availableSkillsDesc}

【输出格式】
必须输出合法的 JSON 格式（不加额外 Markdown 代码块说明）：
{
  "name": "员工岗位名称（如：XX私域金牌主理人）",
  "role_desc": "核心人设概括（说明这个员工是谁、生活背景、边界在哪里，如：35岁同龄二胎宝妈/高压职场实战派大姐姐，自用口碑背书）",
  "persona_lore": {
    "identity_and_background": "详细生活背景（年龄、家庭、白天工作/晚上主理人、作息与生活小烦恼）",
    "vulnerable_origin_story": "曾经经历过的至暗时刻与踩坑血泪史（曾经多难受/试了什么错/花了多少冤枉钱/怎么通过这套方案走出来的真实经历）",
    "lifestyle_habits": ["晨间打卡", "深夜哄睡独处", "空气炸锅低卡餐", "大餐前心虚急救"]
  },
  "personal_stories": [
    "拿自己真实经历举例的故事1（踩坑受罪故事）",
    "拿自己真实经历举例的故事2（第一次见证蜕变的惊喜故事）",
    "拿自己真实经历举例的故事3（大餐聚会/日常急救亲测故事）"
  ],
  "small_talk_anchors": [
    "日常闲聊谈资1（聊娃/家庭/辅导作业抓狂）",
    "日常闲聊谈资2（聊职场/加班/外卖摸鱼）",
    "日常闲聊谈资3（聊吃货心虚/想吃火锅炸鸡又怕长肉）",
    "日常闲聊谈资4（聊换季天气/降温添衣/生活八卦）"
  ],
  "reply_style": "回复风格要求（热情真诚、短句节奏、称呼宝子/姐、严禁Markdown、严禁URL、高情商化解）",
  "service_flow": "生活闲聊破冰 -> 痛点共情与自我举例 -> 保姆级定制方案 -> 专属福利与赠品逼单 -> 周期回访锁客",
  "taboos": ["虚假宣传", "过度承诺", "泄露用户信息", "自行生成URL或链接", "使用Markdown格式"],
  "reassurance_tpl": "当用户情绪激动或心存疑虑时的高情商安抚模版（掏心窝子共情、全程陪跑负责到底）",
  "suggested_skill_ids": [],
  "routing_examples": [
    { "user_says": "今天周一又被老板抓着开会，好烦啊", "route_to": "answer_directly", "reason": "日常闲聊吐槽共情，陪聊唠嗑拉近距离，不生硬推销" },
    { "user_says": "我经常熬夜便秘肚子大，有适合我的吗", "route_to": "answer_directly", "reason": "产品痛点咨询，拿自己经历共情并给出保姆级定制搭配" },
    { "user_says": "吃了拉肚子特别严重，你们是不是假货？", "route_to": "human_handoff", "reason": "极端客诉，先安抚不争辩，转1对1售后专家排查" },
    { "user_says": "我想拿50箱在我的健身房卖，怎么做代理？", "route_to": "human_handoff", "reason": "大额代理招商咨询，转渠道商务总监对接政策" }
  ],
  "delivery_config": {
    "max_reply_length": 150,
    "use_emoji": true,
    "greeting_style": "warm",
    "response_tone": "empathetic"
  },
  "confidence": 0.95,
  "clarification_needed": null,
  "generation_notes": ["赋予3D立体人设与闲聊共情库，兼顾销售力与真实人情味"]
}`;
}

// ─── 核心生成函数 ─────────────────────────────────────────────────────────────

/**
 * 将自然语言招聘意图生成完整 MetaAgentSpec
 * @param intent - 用户的自然语言描述，如"招一个私域群运营员工"
 * @param options - 生成选项
 */
export async function generateSpec(
  intent: string,
  options: {
    extraTaboos?: string[];
    forceDomain?: string;
    extraContext?: string;
  } = {},
): Promise<SpecGenResult> {
  console.log(`[SpecGen] 开始生成 Spec，意图: "${intent}"`);

  // 1. 加载可用技能列表（用于提示词上下文）
  let availableSkillsDesc = '（暂无可用技能列表，需手动配置）';
  try {
    const skills = await listAvailableSkills();
    if (skills.length > 0) {
      availableSkillsDesc = skills
        .slice(0, 15) // 最多展示15个，防止 token 爆炸
        .map(s => `- ${s.id}: ${s.name}（${s.type}）— ${s.description || ''}`)
        .join('\n');
    }
  } catch {
    console.warn('[SpecGen] 无法加载技能列表，将不做技能匹配');
  }

  // 2. 构建用户提示词
  const userPrompt = `请根据以下招聘需求，生成员工画像配置：

【招聘需求】
${intent}

${options.extraContext ? `【补充背景】\n${options.extraContext}\n` : ''}
${options.extraTaboos?.length ? `【额外禁忌（必须包含）】\n${options.extraTaboos.join('、')}\n` : ''}

请直接输出 JSON，不要有任何前缀或解释文字。`;

  // 3. 调用 LLM
  const rawOutput = await callLLM(buildSpecGenSystemPrompt(availableSkillsDesc), userPrompt);

  // 4. 解析 JSON（容错处理）
  let parsed: any;
  try {
    // 清理可能的 Markdown 代码块包裹
    const cleaned = rawOutput
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`[SpecGen] LLM 输出无法解析为 JSON:\n${rawOutput.slice(0, 300)}`);
  }

  // 5. 合并基线禁忌（用 Set 去重）
  const allTaboos = Array.from(new Set([
    ...BASELINE_TABOOS,
    ...(parsed.taboos || []),
    ...(options.extraTaboos || []),
  ]));

  // 6. 推断 knowledge_domain
  const domain = options.forceDomain || inferKnowledgeDomain(intent);

  // 7. 组装最终 Spec
  const spec: MetaAgentSpec = {
    id: generateAgentId(parsed.name || '未命名员工'),
    name: parsed.name || '未命名员工',
    role_desc: parsed.role_desc || '',
    persona_lore: parsed.persona_lore,
    personal_stories: parsed.personal_stories,
    small_talk_anchors: parsed.small_talk_anchors,
    reply_style: parsed.reply_style || '',
    service_flow: parsed.service_flow || '',
    taboos: allTaboos,
    reassurance_tpl: parsed.reassurance_tpl || '我理解您的情况，我们一定会认真处理，请稍等一下。',
    skill_ids: (parsed.suggested_skill_ids || []).slice(0, 5), // 最多5个技能
    routing_examples: (parsed.routing_examples || []).slice(0, 5),
    delivery_config: {
      max_reply_length: parsed.delivery_config?.max_reply_length || 150,
      use_emoji: parsed.delivery_config?.use_emoji ?? true,
      greeting_style: parsed.delivery_config?.greeting_style || 'warm',
      response_tone: parsed.delivery_config?.response_tone || 'empathetic',
    },
    knowledge_domain: domain,
    intent_prompt: intent,
  };

  // 8. 基本校验
  const missing: string[] = [];
  if (!spec.role_desc) missing.push('role_desc');
  if (!spec.reply_style) missing.push('reply_style');
  if (!spec.service_flow) missing.push('service_flow');
  if (spec.taboos.length < 3) missing.push('taboos（至少3条）');

  if (missing.length > 0) {
    throw new Error(`[SpecGen] 生成的 Spec 缺少必填字段: ${missing.join(', ')}`);
  }

  const result: SpecGenResult = {
    spec,
    confidence: parsed.confidence || 0.7,
    clarification_needed: parsed.clarification_needed || null,
    generation_notes: parsed.generation_notes || [],
  };

  console.log(`[SpecGen] ✅ 生成完成: ${spec.name}（ID: ${spec.id}，置信度: ${result.confidence}）`);
  if (result.clarification_needed) {
    console.log(`[SpecGen] ⚠️  需要澄清: ${result.clarification_needed}`);
  }

  return result;
}
