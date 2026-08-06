"use strict";
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
exports.getBundleStatus = getBundleStatus;
exports.buildBundle = buildBundle;
exports.markBundleReady = markBundleReady;
exports.markBundleFailed = markBundleFailed;
exports.getBucketName = getBucketName;
/**
 * bundleService.ts — Skill Bundle 持久安装服务
 *
 * 参照 OpenClaw 的 npm-pack-install 模式：
 * 1. 审核通过后触发安装 → Cloud Run Job 打包依赖
 * 2. 上传到 GCS → gs://skill-platform-bundles/{skillId}/v{N}.tar.gz
 * 3. 下次调用时 runner.py 从 GCS 拉取解压，省掉 pip install
 */
const db = __importStar(require("./db"));
const GCS_BUCKET = process.env.BUNDLE_BUCKET || 'skill-platform-bundles-0884226164';
// ─── 获取 Bundle 状态 ─────────────────────────────────────────────────────────
async function getBundleStatus(skillId) {
    const row = await db.getAsync('SELECT bundle_version, bundle_status, bundle_path, installed_at FROM skills WHERE id=?', [skillId]);
    return {
        skillId,
        version: row?.bundle_version || 0,
        status: row?.bundle_status || 'none',
        path: row?.bundle_path || null,
        installedAt: row?.installed_at || null,
    };
}
// ─── 触发 Bundle 构建 ────────────────────────────────────────────────────────
async function buildBundle(skillId) {
    await db.runAsync(`UPDATE skills SET bundle_status='building', updated_at=? WHERE id=?`, [Date.now(), skillId]);
}
// ─── 标记 Bundle 完成 ─────────────────────────────────────────────────────────
async function markBundleReady(skillId, bundlePath) {
    const row = await db.getAsync('SELECT bundle_version FROM skills WHERE id=?', [skillId]);
    const newVersion = (row?.bundle_version || 0) + 1;
    const path = bundlePath || `gs://${GCS_BUCKET}/${skillId}/v${newVersion}.tar.gz`;
    await db.runAsync(`UPDATE skills SET bundle_status='ready', bundle_version=?, bundle_path=?, installed_at=?, updated_at=? WHERE id=?`, [newVersion, path, Date.now(), Date.now(), skillId]);
}
// ─── 标记 Bundle 失败 ─────────────────────────────────────────────────────────
async function markBundleFailed(skillId) {
    await db.runAsync(`UPDATE skills SET bundle_status='failed', updated_at=? WHERE id=?`, [Date.now(), skillId]);
}
// ─── 获取 GCS Bucket 名称 ─────────────────────────────────────────────────────
function getBucketName() {
    return GCS_BUCKET;
}
