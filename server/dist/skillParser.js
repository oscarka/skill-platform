"use strict";
/**
 * skillParser.ts — SKILL.md 解析器
 *
 * 遵循 AgentSkills / openclaw 规范
 * 提取 frontmatter 和 body，自动识别技能类型
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSkillMd = parseSkillMd;
const jsYaml = __importStar(require("js-yaml"));
/**
 * 解析 SKILL.md 内容，返回结构化信息
 */
function parseSkillMd(content) {
    let frontmatter = {};
    let body = content;
    // ─── 解析 YAML frontmatter ────────────────────────────────────────────────
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fmMatch) {
        body = fmMatch[2].trim();
        const yamlText = fmMatch[1];
        try {
            const parsed = jsYaml.load(yamlText);
            if (parsed && typeof parsed === 'object') {
                frontmatter = parsed;
            }
        }
        catch {
            // 降级到简单解析
            frontmatter = parseYamlLite(yamlText);
        }
    }
    // ─── 提取 metadata.openclaw ─────────────────────────────────────────────
    let ocMeta = {};
    if (frontmatter.metadata && typeof frontmatter.metadata === 'object') {
        // js-yaml 会直接解析成对象，无需 JSON.parse
        ocMeta = frontmatter.metadata?.openclaw
            || frontmatter.metadata?.clawdbot
            || {};
    }
    else if (frontmatter.metadata && typeof frontmatter.metadata === 'string') {
        // 降级：尝试 JSON 解析
        try {
            const parsed = JSON.parse(frontmatter.metadata);
            ocMeta = parsed?.openclaw || parsed?.clawdbot || {};
        }
        catch { /* skip */ }
    }
    const requiresBins = ocMeta?.requires?.bins ?? [];
    const requiresEnv = ocMeta?.requires?.env ?? [];
    const os = ocMeta?.os ?? [];
    // ─── 自动识别技能类型 ──────────────────────────────────────────────────────
    const hasScripts = /scripts\//.test(body);
    const hasShellBlock = /```\s*(bash|sh|shell|zsh)/i.test(body);
    const hasExecKeywords = /\b(exec|subprocess|os\.system|Popen)\b/.test(body);
    // mcporter 调用（如 stitch-ui-designer）说明需要 MCP 沙箱环境
    const hasMcporter = /\bmcporter\b/.test(body) || requiresBins.includes('mcporter');
    const isScript = requiresBins.length > 0 ||
        hasScripts ||
        hasShellBlock ||
        hasExecKeywords ||
        hasMcporter;
    const slug = String(frontmatter.name || '');
    // ClaWHub skills 托管在 GitHub openclaw 组织，路径格式 openclaw/<slug>
    const repoUrl = slug ? `https://github.com/openclaw/${slug}` : '';
    return {
        name: slug,
        description: String(frontmatter.description || ''),
        body,
        skillType: isScript ? 'script' : 'prompt',
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
function parseYamlLite(yaml) {
    const result = {};
    const lines = yaml.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const kv = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*):\s*(.*)/);
        if (!kv) {
            i++;
            continue;
        }
        const key = kv[1];
        const val = kv[2].trim();
        if (!val) {
            const block = [];
            i++;
            while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t') || lines[i] === '')) {
                block.push(lines[i]);
                i++;
            }
            result[key] = block.join('\n').trim();
        }
        else {
            result[key] = val.replace(/^['"]|['"]$/g, '');
            i++;
        }
    }
    return result;
}
