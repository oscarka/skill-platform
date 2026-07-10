/**
 * AI Runner — 多模型统一调用接口
 *
 * 支持: Gemini / 豆包(Doubao) / DeepSeek
 * 豆包和 DeepSeek 都兼容 OpenAI SDK 接口，统一走 openai 库
 */

import * as db from './db';

export type ModelProvider = 'gemini' | 'doubao' | 'deepseek';

export interface RunOptions {
  model?: string;           // 指定模型名，如 doubao-pro-128k
  fallback?: string;        // 失败时备用模型
  maxTokens?: number;
  temperature?: number;
  /** 附件：用于多模态（图片/PDF 的文字已由调用方提取后放入 prompt） */
  systemPrompt?: string;
}

export interface RunResult {
  text: string;
  model: string;
  provider: ModelProvider;
  tokens?: number;
}

// ─── 从数据库或环境变量读取配置 ────────────────────────────────────────────────

async function getSetting(key: string, fallbackEnv: string): Promise<string> {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  if (row?.value) return row.value;
  return process.env[fallbackEnv] || '';
}

async function getConfig() {
  const [geminiKey, doubaoKey, doubaoBase, deepseekKey, deepseekBase, defaultModel] = await Promise.all([
    getSetting('gemini_api_key',   'GEMINI_API_KEY'),
    getSetting('doubao_api_key',   'DOUBAO_API_KEY'),
    getSetting('doubao_base_url',  'DOUBAO_BASE_URL'),
    getSetting('deepseek_api_key', 'DEEPSEEK_API_KEY'),
    getSetting('deepseek_base_url','DEEPSEEK_BASE_URL'),
    getSetting('default_model',    'DEFAULT_MODEL'),
  ]);
  return { geminiKey, doubaoKey, doubaoBase, deepseekKey, deepseekBase, defaultModel };
}

// ─── 模型名称 → provider 推断 ──────────────────────────────────────────────────

function inferProvider(modelName: string): ModelProvider {
  if (modelName.startsWith('gemini')) return 'gemini';
  if (modelName.startsWith('doubao') || modelName.startsWith('ep-')) return 'doubao';
  if (modelName.startsWith('deepseek')) return 'deepseek';
  return 'gemini'; // fallback
}

// ─── Gemini 调用 ──────────────────────────────────────────────────────────────

async function runGemini(prompt: string, model: string, apiKey: string, opts: RunOptions): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      maxOutputTokens: opts.maxTokens || 4096,
      temperature: opts.temperature ?? 0.3,
      systemInstruction: opts.systemPrompt,
    },
  });
  return response.text || '';
}

// ─── OpenAI 兼容接口（豆包 / DeepSeek） ──────────────────────────────────────

async function runOpenAICompat(
  prompt: string,
  model: string,
  apiKey: string,
  baseURL: string,
  opts: RunOptions
): Promise<string> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey, baseURL, timeout: 180_000 });

  const messages: any[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // seed 系列模型（推理模型）用 stream 避免超时
  const useStream = model.includes('seed');

  if (useStream) {
    const stream = await client.chat.completions.create({
      model,
      messages,
      max_tokens: opts.maxTokens || 4096,
      temperature: opts.temperature ?? 0.3,
      stream: true,
    });
    let content = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
    }
    if (!content) {
      throw new Error(`模型 ${model} 返回空内容，请尝试简化 Prompt 或换用其他模型。`);
    }
    return content;
  }

  // 非 seed 模型用普通接口
  const timeoutMs = 120_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`AI request timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  const aiPromise = client.chat.completions.create({
    model,
    messages,
    max_tokens: opts.maxTokens || 4096,
    temperature: opts.temperature ?? 0.3,
  });
  const resp = await Promise.race([aiPromise, timeoutPromise]);
  const content = resp.choices[0]?.message?.content;
  if (!content) {
    const finishReason = resp.choices[0]?.finish_reason;
    throw new Error(`模型返回空内容（finish_reason: ${finishReason || 'unknown'}）。请换用其他模型。`);
  }
  return content;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export async function runAI(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const config = await getConfig();
  const targetModel = opts.model || config.defaultModel || 'gemini-2.0-flash';
  const provider = inferProvider(targetModel);

  const tryRun = async (model: string): Promise<string> => {
    const p = inferProvider(model);
    if (p === 'gemini') {
      if (!config.geminiKey) throw new Error('Gemini API key not configured. Please set it in Settings.');
      return runGemini(prompt, model, config.geminiKey, opts);
    } else if (p === 'doubao') {
      if (!config.doubaoKey) throw new Error('Doubao API key not configured. Please set it in Settings.');
      const base = config.doubaoBase || 'https://ark.cn-beijing.volces.com/api/v3';
      return runOpenAICompat(prompt, model, config.doubaoKey, base, opts);
    } else {
      if (!config.deepseekKey) throw new Error('DeepSeek API key not configured. Please set it in Settings.');
      const base = config.deepseekBase || 'https://api.deepseek.com';
      return runOpenAICompat(prompt, model, config.deepseekKey, base, opts);
    }
  };

  let text: string;
  let usedModel = targetModel;
  try {
    text = await tryRun(targetModel);
  } catch (err: any) {
    if (opts.fallback) {
      console.warn(`[AIRunner] Primary model ${targetModel} failed (${err.message}), trying fallback ${opts.fallback}`);
      text = await tryRun(opts.fallback);
      usedModel = opts.fallback;
    } else {
      throw err;
    }
  }

  return { text, model: usedModel, provider: inferProvider(usedModel) };
}
