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
import { listAvailableSkills } from './apiClient';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface MetaAgentSpec {
  id: string;
  name: string;
  role_desc: string;        // 职位描述（是什么、做什么）
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
  const slug = name
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 20);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `agent_${slug}_${suffix}`;
}

// ─── LLM 调用（通过环境变量配置，兼容 Doubao / DeepSeek / Gemini）────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  const model = process.env.SPEC_GEN_MODEL || 'doubao-1.5-pro-32k-250115';
  const baseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

  if (!apiKey) {
    throw new Error('[SpecGen] 未配置 LLM API Key（需要 DOUBAO_API_KEY 或 ARK_API_KEY）');
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,  // 低温度保证输出稳定、可解析
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[SpecGen] LLM API 调用失败: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ─── Spec 生成提示词 ──────────────────────────────────────────────────────────

function buildSpecGenSystemPrompt(availableSkillsDesc: string): string {
  return `你是一个 AI 员工招募顾问，专门负责将人类的"招聘意图"转化为结构化的"员工画像配置"。

【核心原则】
1. 你生成的是「员工画像」，不是「业务脚本」。画像描述员工的性格、风格、职责边界，不要把具体的业务知识硬写进去。
2. reply_style 只描述"怎么说话"（语气、字数、格式约束），不描述"说什么内容"。
3. service_flow 只描述"做事步骤"（动词序列），不超过6步，不含具体台词。
4. taboos 是零容忍的行为禁区，必须具体且可测试（能用代码判断违反）。
5. 不要过拟合：不要把招聘需求里的例子直接写进 spec，要提炼为通用行为准则。

【可用技能列表】
${availableSkillsDesc}

【输出格式】
必须输出合法的 JSON，格式如下（不加 Markdown 代码块）：
{
  "name": "员工岗位名称",
  "role_desc": "职责描述（2-3句话，说明这个员工是谁、负责什么、边界在哪里）",
  "reply_style": "回复风格（说明语气、字数上限、禁止格式，不超过100字）",
  "service_flow": "步骤1 → 步骤2 → 步骤3（最多6步）",
  "taboos": ["禁忌1", "禁忌2", "禁忌3"],
  "reassurance_tpl": "当用户情绪激动时使用的安抚话术（1-2句，自然语言）",
  "suggested_skill_ids": ["skill_id_1"],
  "routing_examples": [
    { "user_says": "用户说了什么", "route_to": "skill_id或human_handoff", "reason": "路由原因" }
  ],
  "delivery_config": {
    "max_reply_length": 150,
    "use_emoji": true,
    "greeting_style": "casual",
    "response_tone": "friendly"
  },
  "confidence": 0.9,
  "clarification_needed": null,
  "generation_notes": ["注意点1"]
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
    reply_style: parsed.reply_style || '',
    service_flow: parsed.service_flow || '',
    taboos: allTaboos,
    reassurance_tpl: parsed.reassurance_tpl || '我理解您的情况，我们一定会认真处理，请稍等一下。',
    skill_ids: (parsed.suggested_skill_ids || []).slice(0, 5), // 最多5个技能
    routing_examples: (parsed.routing_examples || []).slice(0, 5),
    delivery_config: {
      max_reply_length: parsed.delivery_config?.max_reply_length || 150,
      use_emoji: parsed.delivery_config?.use_emoji ?? true,
      greeting_style: parsed.delivery_config?.greeting_style || 'casual',
      response_tone: parsed.delivery_config?.response_tone || 'friendly',
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
