"use strict";
/**
 * transcriptService.ts — Transcript 存储/检索服务
 *
 * 参照 OpenClaw TranscriptsStore + session-transcript-readers.ts：
 * 1. 从 GCS 读取双份 transcript（full / display）
 * 2. 提供 API 接口给前端查询
 * 3. 读取 spill 文件（大输出落盘）
 *
 * 使用 gcloud CLI 代替 @google-cloud/storage SDK（避免额外依赖）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readDisplayTranscript = readDisplayTranscript;
exports.readFullTranscript = readFullTranscript;
exports.readSpillFile = readSpillFile;
exports.listTranscripts = listTranscripts;
exports.summarizeTranscript = summarizeTranscript;
const child_process_1 = require("child_process");
const BUCKET_NAME = 'skill-platform-bundles-0884226164';
// ─── GCS 读取工具函数 ────────────────────────────────────────────────────────
function readGcsFile(gcsPath) {
    try {
        const result = (0, child_process_1.execSync)(`gcloud storage cat "${gcsPath}"`, {
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024, // 10MB
        });
        return result;
    }
    catch (err) {
        throw new Error(`Failed to read ${gcsPath}: ${err.message}`);
    }
}
// ─── 读取截断版 transcript（给 UI 展示）──────────────────────────────────────
function readDisplayTranscript(gcsInfo) {
    const path = gcsInfo['transcript.json'];
    if (!path)
        return [];
    try {
        const content = readGcsFile(path);
        return JSON.parse(content);
    }
    catch (err) {
        console.error('[transcriptService] readDisplayTranscript error:', err);
        return [];
    }
}
// ─── 读取完整版 transcript（给 debug）────────────────────────────────────────
function readFullTranscript(gcsInfo) {
    const path = gcsInfo['transcript_full.jsonl'];
    if (!path)
        return [];
    try {
        const content = readGcsFile(path);
        // JSONL: 每行一个 JSON
        return content.trim().split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
    }
    catch (err) {
        console.error('[transcriptService] readFullTranscript error:', err);
        return [];
    }
}
// ─── 读取 spill 文件（大输出落盘的完整内容）──────────────────────────────────
function readSpillFile(spillGcsPath) {
    try {
        return readGcsFile(spillGcsPath);
    }
    catch (err) {
        console.error('[transcriptService] readSpillFile error:', err);
        return `[Error reading spill file: ${err}]`;
    }
}
// ─── 列出某个 skill 的所有 transcript ────────────────────────────────────────
function listTranscripts(skillId) {
    try {
        const prefix = `gs://${BUCKET_NAME}/transcripts/${skillId}/`;
        const result = (0, child_process_1.execSync)(`gcloud storage ls "${prefix}" 2>/dev/null || true`, {
            encoding: 'utf-8',
            timeout: 15_000,
        });
        // 解析 gs://bucket/transcripts/{skillId}/{timestamp}/ 格式
        const timestamps = new Set();
        for (const line of result.trim().split('\n')) {
            const match = line.match(/\/(\d+)\/$/);
            if (match) {
                timestamps.add(match[1]);
            }
        }
        return Array.from(timestamps)
            .map(ts => ({ prefix: `transcripts/${skillId}/${ts}`, timestamp: parseInt(ts) }))
            .sort((a, b) => b.timestamp - a.timestamp); // 最新在前
    }
    catch (err) {
        console.error('[transcriptService] listTranscripts error:', err);
        return [];
    }
}
// ─── 计算 transcript 摘要（给列表页展示）────────────────────────────────────
function summarizeTranscript(entries) {
    let messageCount = 0;
    let toolCalls = 0;
    let truncatedCount = 0;
    let spillCount = 0;
    for (const entry of entries) {
        if (entry.type === 'message') {
            messageCount++;
            if (entry.role === 'tool') {
                toolCalls++;
                if (entry.is_truncated)
                    truncatedCount++;
                if (entry.spill_path)
                    spillCount++;
            }
        }
    }
    // 时长
    const header = entries.find(e => e.type === 'header');
    const lastEntry = entries[entries.length - 1];
    let duration;
    if (header?.ts && lastEntry?.ts) {
        const ms = new Date(lastEntry.ts).getTime() - new Date(header.ts).getTime();
        duration = `${(ms / 1000).toFixed(1)}s`;
    }
    return { totalEntries: entries.length, messageCount, toolCalls, truncatedCount, spillCount, duration };
}
