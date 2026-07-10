/**
 * bundleService.ts — Skill Bundle 持久安装服务
 * 
 * 参照 OpenClaw 的 npm-pack-install 模式：
 * 1. 审核通过后触发安装 → Cloud Run Job 打包依赖
 * 2. 上传到 GCS → gs://skill-platform-bundles/{skillId}/v{N}.tar.gz
 * 3. 下次调用时 runner.py 从 GCS 拉取解压，省掉 pip install
 */
import * as db from './db';

const GCS_BUCKET = process.env.BUNDLE_BUCKET || 'skill-platform-bundles-0884226164';

export interface BundleStatus {
  skillId: string;
  version: number;
  status: 'none' | 'building' | 'ready' | 'failed';
  path: string | null;
  installedAt: number | null;
}

// ─── 获取 Bundle 状态 ─────────────────────────────────────────────────────────
export async function getBundleStatus(skillId: string): Promise<BundleStatus> {
  const row = await db.getAsync<any>(
    'SELECT bundle_version, bundle_status, bundle_path, installed_at FROM skills WHERE id=?',
    [skillId]
  );
  return {
    skillId,
    version: row?.bundle_version || 0,
    status: row?.bundle_status || 'none',
    path: row?.bundle_path || null,
    installedAt: row?.installed_at || null,
  };
}

// ─── 触发 Bundle 构建 ────────────────────────────────────────────────────────
export async function buildBundle(skillId: string): Promise<void> {
  await db.runAsync(
    `UPDATE skills SET bundle_status='building', updated_at=? WHERE id=?`,
    [Date.now(), skillId]
  );
}

// ─── 标记 Bundle 完成 ─────────────────────────────────────────────────────────
export async function markBundleReady(skillId: string, bundlePath?: string): Promise<void> {
  const row = await db.getAsync<any>('SELECT bundle_version FROM skills WHERE id=?', [skillId]);
  const newVersion = (row?.bundle_version || 0) + 1;
  const path = bundlePath || `gs://${GCS_BUCKET}/${skillId}/v${newVersion}.tar.gz`;
  await db.runAsync(
    `UPDATE skills SET bundle_status='ready', bundle_version=?, bundle_path=?, installed_at=?, updated_at=? WHERE id=?`,
    [newVersion, path, Date.now(), Date.now(), skillId]
  );
}

// ─── 标记 Bundle 失败 ─────────────────────────────────────────────────────────
export async function markBundleFailed(skillId: string): Promise<void> {
  await db.runAsync(
    `UPDATE skills SET bundle_status='failed', updated_at=? WHERE id=?`,
    [Date.now(), skillId]
  );
}

// ─── 获取 GCS Bucket 名称 ─────────────────────────────────────────────────────
export function getBucketName(): string {
  return GCS_BUCKET;
}
