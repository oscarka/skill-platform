import { useState, useEffect } from 'react';
import { api } from '../lib/api';

const KEY_LABELS: Record<string, string> = {
  gemini_api_key: 'Gemini API Key',
  doubao_api_key: '豆包 API Key',
  doubao_base_url: '豆包 Base URL',
  deepseek_api_key: 'DeepSeek API Key',
  deepseek_base_url: 'DeepSeek Base URL',
  default_model: '默认 AI 模型',
  ticket_expiry_days: 'H5 链接有效期（天）',
  h5_base_url: 'H5 客户端地址',
};

// API key → provider 映射
const KEY_PROVIDER: Record<string, string> = {
  gemini_api_key: 'gemini',
  doubao_api_key: 'doubao',
  deepseek_api_key: 'deepseek',
};

export default function Settings() {
  const [settings, setSettings] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 测试连接状态
  const [testResults, setTestResults] = useState<Record<string, any>>({});

  useEffect(() => {
    api.settings.list().then(d => setSettings(d.settings));
    api.settings.models().then(d => setModels(d.models));
  }, []);

  const handleChange = (key: string, val: string) => setEdits(e => ({ ...e, [key]: val }));

  const handleSave = async () => {
    const toSave: Record<string, string> = {};
    for (const [k, v] of Object.entries(edits)) {
      if (v && v !== '••••' && !v.startsWith('****')) toSave[k] = v;
    }
    if (!Object.keys(toSave).length) return;
    setSaving(true);
    try {
      await api.settings.update(toSave);
      const d = await api.settings.list();
      setSettings(d.settings);
      setEdits({});
      setMsg({ type: 'success', text: '保存成功' });
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const handleTestKey = async (provider: string) => {
    setTestResults(prev => ({ ...prev, [provider]: { testing: true } }));
    try {
      const res = await fetch('/api/settings/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [provider]: { ...data, testing: false } }));
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [provider]: { ok: false, error: err.message, testing: false } }));
    }
  };

  const groups = [
    { title: '🤖 AI 模型配置', keys: ['gemini_api_key', 'doubao_api_key', 'doubao_base_url', 'deepseek_api_key', 'deepseek_base_url'] },
    { title: '⚡ 默认设置', keys: ['default_model', 'ticket_expiry_days', 'h5_base_url'] },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>平台设置</h1>
          <p>配置 AI 模型 Key 和平台参数</p>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '💾 保存设置'}
        </button>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20, alignItems: 'start' }}>
        {/* Left — config form */}
        <div>
          {groups.map(group => (
            <div className="card mb-4" key={group.title}>
              <div className="card-title">{group.title}</div>
              {group.keys.map(key => {
                const s = settings.find(x => x.key === key);
                const isModel = key === 'default_model';
                const provider = KEY_PROVIDER[key];
                const testResult = provider ? testResults[provider] : null;
                return (
                  <div className="form-group" key={key}>
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {KEY_LABELS[key] || key}
                      {s?.configured && (
                        <span style={{ fontSize: '.72rem', color: 'var(--success)', fontWeight: 400 }}>✓ 已配置</span>
                      )}
                      {/* 测试连接按钮 */}
                      {provider && s?.configured && (
                        <button
                          onClick={() => handleTestKey(provider)}
                          disabled={testResult?.testing}
                          style={{
                            marginLeft: 'auto', fontSize: '.75rem', padding: '2px 10px',
                            border: '1px solid var(--gray-200)', borderRadius: 6,
                            background: testResult?.ok === true ? '#e6f9e6' : testResult?.ok === false ? '#ffeaea' : 'var(--gray-50)',
                            color: testResult?.ok === true ? 'var(--success)' : testResult?.ok === false ? 'var(--danger)' : 'var(--gray-600)',
                            cursor: testResult?.testing ? 'wait' : 'pointer',
                          }}>
                          {testResult?.testing ? '⏳ 测试中…' :
                           testResult?.ok === true ? `✅ 连通 (${testResult.elapsed}ms)` :
                           testResult?.ok === false ? '❌ 失败' :
                           '🔌 测试连接'}
                        </button>
                      )}
                    </label>
                    {/* 测试结果详情 */}
                    {testResult && !testResult.testing && (
                      <div style={{
                        fontSize: '.78rem', padding: '6px 10px', marginBottom: 6, borderRadius: 6,
                        background: testResult.ok ? '#f0faf0' : '#fef2f2',
                        color: testResult.ok ? '#166534' : '#991b1b',
                        border: `1px solid ${testResult.ok ? '#bbf7d0' : '#fecaca'}`,
                      }}>
                        {testResult.ok
                          ? <>✅ 连接成功 · 模型: {testResult.model} · 延迟: {testResult.elapsed}ms · 回复: &quot;{testResult.reply}&quot;</>
                          : <>❌ {testResult.error}</>
                        }
                      </div>
                    )}
                    {isModel ? (
                      <select className="form-select" value={edits[key] ?? (s?.value || '')} onChange={e => handleChange(key, e.target.value)}>
                        <option value="">选择默认模型…</option>
                        {models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    ) : (
                      <input
                        className="form-input"
                        type={key.includes('api_key') ? 'password' : 'text'}
                        placeholder={s?.configured ? '（已配置，输入新值覆盖）' : `请输入 ${KEY_LABELS[key] || key}`}
                        value={edits[key] ?? ''}
                        onChange={e => handleChange(key, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Right — model list (sticky) */}
        <div style={{ position: 'sticky', top: 80 }}>
          <div className="card">
            <div className="card-title">📊 可用模型</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {models.map((m: any) => (
                <div key={m.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', background: 'var(--gray-50)',
                  borderRadius: 8, border: '1px solid var(--gray-100)',
                }}>
                  <span className="badge badge-internal" style={{ flexShrink: 0 }}>{m.provider}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--gray-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.id}</div>
                    <div style={{ fontSize: '.74rem', color: 'var(--gray-400)' }}>{m.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
