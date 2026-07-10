/**
 * skillParser.ts — SKILL.md 解析器
 *
 * 遵循 AgentSkills / openclaw 规范
 * 提取 frontmatter 和 body，自动识别技能类型
 */

import * as jsYaml from 'js-yaml';

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;              // Markdown 正文（作为 System Prompt）
  skillType: 'prompt' | 'script';
  requiresBins: string[];    // 需要的系统命令
  requiresEnv: string[];     // 需要的环境变量
  os: string[];
  hasScripts: boolean;       // 是否引用 scripts/ 目录
  slug: string;              // ClaWHub slug（从 frontmatter name 字段）
  repoUrl: string;           // ClaWHub GitHub repo URL（如能推断）
}

/**
 * 解析 SKILL.md 内容，返回结构化信息
 */
export function parseSkillMd(content: string): ParsedSkill {
  let frontmatter: Record<string, any> = {};
  let body = content;

  // ─── 解析 YAML frontmatter ────────────────────────────────────────────────
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    body = fmMatch[2].trim();
    const yamlText = fmMatch[1];
    try {
      const parsed = jsYaml.load(yamlText);
      if (parsed && typeof parsed === 'object') {
        frontmatter = parsed as Record<string, any>;
      }
    } catch {
      // 降级到简单解析
      frontmatter = parseYamlLite(yamlText);
    }
  }

  // ─── 提取 metadata.openclaw ─────────────────────────────────────────────
  let ocMeta: any = {};
  if (frontmatter.metadata && typeof frontmatter.metadata === 'object') {
    // js-yaml 会直接解析成对象，无需 JSON.parse
    ocMeta = (frontmatter.metadata as any)?.openclaw
          || (frontmatter.metadata as any)?.clawdbot
          || {};
  } else if (frontmatter.metadata && typeof frontmatter.metadata === 'string') {
    // 降级：尝试 JSON 解析
    try {
      const parsed = JSON.parse(frontmatter.metadata);
      ocMeta = parsed?.openclaw || parsed?.clawdbot || {};
    } catch { /* skip */ }
  }

  const requiresBins: string[] = ocMeta?.requires?.bins ?? [];
  const requiresEnv: string[] = ocMeta?.requires?.env ?? [];
  const os: string[] = ocMeta?.os ?? [];

  // ─── 自动识别技能类型 ──────────────────────────────────────────────────────
  const hasScripts = /scripts\//.test(body);
  const hasShellBlock = /```\s*(bash|sh|shell|zsh)/i.test(body);
  const hasExecKeywords = /\b(exec|subprocess|os\.system|Popen)\b/.test(body);
  // mcporter 调用（如 stitch-ui-designer）说明需要 MCP 沙箱环境
  const hasMcporter = /\bmcporter\b/.test(body) || requiresBins.includes('mcporter');

  const isScript =
    requiresBins.length > 0 ||
    hasScripts ||
    hasShellBlock ||
    hasExecKeywords ||
    hasMcporter;

  const slug = String(frontmatter.name || '');
  // ClaWHub skills 托管在 GitHub openclaw 组织，路径格式 openclaw/<slug>
  const repoUrl = slug ? `https://github.com/openclaw/${slug}` : '';

  return {
    name:         slug,
    description:  String(frontmatter.description || ''),
    body,
    skillType:    isScript ? 'script' : 'prompt',
    requiresBins,
    requiresEnv,
    os,
    hasScripts,
    slug,
    repoUrl,
  };
}

/**
 * 超轻量 YAML 解析（降级用，仅支持顶层 key: value）
 */
function parseYamlLite(yaml: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*):\s*(.*)/);
    if (!kv) { i++; continue; }

    const key = kv[1];
    const val = kv[2].trim();

    if (!val) {
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t') || lines[i] === '')) {
        block.push(lines[i]);
        i++;
      }
      result[key] = block.join('\n').trim();
    } else {
      result[key] = val.replace(/^['"]|['"]$/g, '');
      i++;
    }
  }

  return result;
}
