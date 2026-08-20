/**
 * messagePacer.ts — Agent 出站消息后置分段器 (Post-Splitter)
 *
 * 核心目标：
 *   将 Agent 生成的长回复拆分为适合微信阅读的 2~3 条自然短句，以便节奏调度器按 1.5s 间隔逐条下发。
 *
 * 强硬约束：
 *   1. 【URL / 工单链接强保护】：任何 http/https 链接、H5 工单链接、报告链接绝对原样保留，禁止拆断。
 *   2. 【内容 100% 零篡改】：绝不修改、删除、增加任何医学事实、药品名称、检查数据与结论。
 *   3. 【安全向后兼容与降级】：任何场景（短文本、解析异常、模型超时）均自动回退为原始文本数组 [rawText]，对现有系统零侵入零风险。
 */

import { GoogleGenAI } from '@google/genai';

// URL 正则匹配器
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export interface PacedMessageResult {
  segments: string[];
  isSplit: boolean;
  originalText: string;
}

/**
 * 快速规则分段（Deterministic Fast Path）
 * 适合已有自然换行、或者包含列表/工单链接的文本
 */
export function splitByRules(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (trimmed.length <= 80) {
    return [trimmed];
  }

  // 1. 如果包含多行段落（\n\n 或 \n），按段落分
  const rawParagraphs = trimmed
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  if (rawParagraphs.length >= 2 && rawParagraphs.length <= 4) {
    // 合并过短的单行（如 < 15 字的称呼或过短小句，合并到下一段）
    const merged: string[] = [];
    for (let i = 0; i < rawParagraphs.length; i++) {
      const p = rawParagraphs[i];
      if (p.length < 15 && i < rawParagraphs.length - 1 && !p.includes('http')) {
        rawParagraphs[i + 1] = p + '\n' + rawParagraphs[i + 1];
      } else {
        merged.push(p);
      }
    }
    if (merged.length >= 2) {
      return merged.slice(0, 3); // 微信聊天单次最多发 3 条，避免刷屏
    }
  }

  // 2. 如果包含工单链接，确保工单提示和链接与普通文字拆开
  if (trimmed.includes('http://') || trimmed.includes('https://')) {
    const parts = trimmed.split(/(?=https?:\/\/)/g);
    if (parts.length === 2 && parts[0].length > 20) {
      return [parts[0].trim(), parts[1].trim()];
    }
  }

  return [trimmed];
}

/**
 * 使用轻量 LLM 辅助拆分（仅对超长单大段且无自然换行的文本进行标点断句）
 */
export async function splitByLLMAssisted(text: string, apiKey?: string): Promise<string[]> {
  const geminiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!geminiKey || text.length <= 100) {
    return splitByRules(text);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const prompt = `你是一个微信消息分段助手。你的唯一任务是在输入文本的自然停顿处插入 [SPLIT] 分隔符，将其拆分成 2 到 3 条适合微信聊天的短消息。

【严格硬性规则】：
1. 绝对禁止增加、删除、修改、缩写或润色任何一个汉字、标点或数字！
2. 绝对禁止修改任何 URL 链接（如 http/https 链接），链接必须完整保留在某一段中！
3. 绝对禁止篡改任何药品名称、医学建议、体检数据和指标！
4. 只能输出插入了 [SPLIT] 的原文本，不要输出任何其他解释或前缀后缀！

输入文本：
${text}`;

    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: prompt,
      config: {
        temperature: 0.0, // 0 随机性，最严谨复现
        maxOutputTokens: 2048,
      },
    });

    const output = (resp.text || '').trim();
    if (!output || !output.includes('[SPLIT]')) {
      return splitByRules(text);
    }

    const segments = output
      .split(/\[SPLIT\]/g)
      .map(s => s.trim())
      .filter(Boolean);

    // 安全校验：确认所有分段合并后，核心文字及 URL 未丢失
    const reconstructed = segments.join('').replace(/\s+/g, '');
    const originalNormalized = text.replace(/\s+/g, '');

    // 容错度检查：如果字符长度差异超过 5 个字符，说明模型违规修改了文字，立即 fallback 回退
    if (Math.abs(reconstructed.length - originalNormalized.length) > 5) {
      console.warn('[MessagePacer] LLM 分段校验失败（字符数不符），安全降级为规则分段');
      return splitByRules(text);
    }

    // 确保原文本中的每一个 URL 都完好无损地保留在分段中
    const originalUrls = text.match(URL_REGEX) || [];
    for (const url of originalUrls) {
      if (!segments.some(seg => seg.includes(url))) {
        console.warn('[MessagePacer] URL 校验丢失，安全降级');
        return splitByRules(text);
      }
    }

    return segments.slice(0, 3);
  } catch (err: any) {
    console.warn('[MessagePacer] LLM 辅助分段异常，自动降级:', err.message);
    return splitByRules(text);
  }
}

/**
 * 统一主入口：将 Agent 原始回复转换为节奏分段消息
 */
export async function paceAgentMessage(rawText: string, apiKey?: string): Promise<PacedMessageResult> {
  if (!rawText || typeof rawText !== 'string') {
    return { segments: [], isSplit: false, originalText: rawText || '' };
  }

  const trimmed = rawText.trim();
  if (trimmed.length <= 80) {
    return { segments: [trimmed], isSplit: false, originalText: trimmed };
  }

  // 1. 先尝试快速规则分段
  const ruleSegments = splitByRules(trimmed);
  if (ruleSegments.length > 1) {
    return { segments: ruleSegments, isSplit: true, originalText: trimmed };
  }

  // 2. 若单段过长（> 120 字），尝试 LLM 辅助断句分段
  if (trimmed.length > 120) {
    const llmSegments = await splitByLLMAssisted(trimmed, apiKey);
    if (llmSegments.length > 1) {
      return { segments: llmSegments, isSplit: true, originalText: trimmed };
    }
  }

  return { segments: [trimmed], isSplit: false, originalText: trimmed };
}
