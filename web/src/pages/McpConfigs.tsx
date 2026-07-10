import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface McpConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  description?: string;
  created_at: number;
}

const EMPTY = { name: '', command: 'npx', args: '', description: '' };

export default function McpConfigs() {
  const [configs, setConfigs] = useState<McpConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = () => {
    setLoading(true);
    api.mcpConfigs.list().then(d => setConfigs(d.configs || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleEdit = (c: McpConfig) => {
    setForm({ name: c.name, command: c.command, args: c.args, description: c.description || '' });
    setEditId(c.id);
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.command) return;
    setSaving(true);
    try {
      if (editId) {
        await api.mcpConfigs.update(editId, form);
      } else {
        await api.mcpConfigs.create(form);
      }
      setForm(EMPTY);
      setEditId(null);
      setShowForm(false);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除 MCP 配置「${name}」吗？`)) return;
    await api.mcpConfigs.delete(id);
    setConfigs(prev => prev.filter(c => c.id !== id));
  };

  const mcporterCmd = (c: McpConfig) =>
    `mcporter config add ${c.name} --command ${c.command}${c.args ? ` --args '${c.args}'` : ''}`;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>🔌 MCP 配置管理</h1>
          <p>管理沙箱测试中可用的 MCP 服务（mcporter 配置）</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm(EMPTY); setEditId(null); setShowForm(true); }}>
          ➕ 添加 MCP 服务
        </button>
      </div>

      {showForm && (
        <div className="card mb-4">
          <h3 style={{ marginTop: 0, marginBottom: 16 }}>{editId ? '编辑' : '添加'} MCP 服务</h3>
          <form onSubmit={handleSave} style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '.85rem', marginBottom: 4, color: 'var(--gray-600)' }}>
                  服务名称 <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input className="form-input" placeholder="例：stitch" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.85rem', marginBottom: 4, color: 'var(--gray-600)' }}>
                  启动命令 <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input className="form-input" placeholder="例：npx" value={form.command}
                  onChange={e => setForm(f => ({ ...f, command: e.target.value }))} required />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.85rem', marginBottom: 4, color: 'var(--gray-600)' }}>
                参数（args）
              </label>
              <input className="form-input" placeholder="例：-y stitch-mcp-auto" value={form.args}
                onChange={e => setForm(f => ({ ...f, args: e.target.value }))} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.85rem', marginBottom: 4, color: 'var(--gray-600)' }}>说明</label>
              <input className="form-input" placeholder="可选：描述这个 MCP 服务的用途" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            {form.name && form.command && (
              <div style={{ background: 'var(--gray-50)', borderRadius: 6, padding: '8px 12px', fontSize: '.82rem', color: 'var(--gray-600)', fontFamily: 'monospace' }}>
                预览：{mcporterCmd({ ...form, id: '', created_at: 0 })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? '保存中…' : '💾 保存'}
              </button>
              <button className="btn" type="button" onClick={() => { setShowForm(false); setEditId(null); }}>取消</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading">加载中…</div>
      ) : configs.length === 0 ? (
        <div className="empty-state">
          <p>暂无 MCP 配置。添加后，沙箱测试会自动注入这些配置，AI 无需手动 config add。</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {configs.map(c => (
            <div key={c.id} className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ fontSize: '1.5rem' }}>🔌</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <strong style={{ fontSize: '1rem' }}>{c.name}</strong>
                  <code style={{ background: 'var(--gray-100)', padding: '1px 6px', borderRadius: 4, fontSize: '.78rem' }}>
                    {c.command}
                  </code>
                </div>
                {c.description && <p style={{ margin: '0 0 6px', fontSize: '.85rem', color: 'var(--gray-600)' }}>{c.description}</p>}
                <code style={{ display: 'block', background: 'var(--gray-50)', padding: '6px 10px', borderRadius: 6, fontSize: '.78rem', color: 'var(--gray-700)', wordBreak: 'break-all' }}>
                  {mcporterCmd(c)}
                </code>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn" style={{ fontSize: '.8rem', padding: '4px 10px' }} onClick={() => handleEdit(c)}>✏️ 编辑</button>
                <button className="btn" style={{ fontSize: '.8rem', padding: '4px 10px', color: 'var(--danger)' }}
                  onClick={() => handleDelete(c.id, c.name)}>🗑️ 删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
