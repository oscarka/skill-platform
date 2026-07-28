import { useState } from 'react';

// ─── 图片渲染块 ────────────────────────────────────────────────────────────────
export function ImageBlock({ url, isBase64 = false }: { url: string; isBase64?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div style={{ padding: '8px 12px', background: '#fff5f5', border: '1px solid #fecaca', borderRadius: 6, fontSize: '.82rem', color: '#dc2626' }}>
        🖼️ 图片加载失败：{url.slice(0, 80)}…
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 4 }}>
      <img
        src={url}
        alt="Skill 输出图片"
        onError={() => setError(true)}
        onClick={() => setExpanded(!expanded)}
        style={{
          maxWidth: expanded ? '100%' : 480,
          maxHeight: expanded ? 'none' : 300,
          borderRadius: 8,
          border: '1px solid var(--gray-200)',
          cursor: 'zoom-in',
          display: 'block',
          objectFit: 'contain',
          transition: 'max-width .2s, max-height .2s',
        }}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ fontSize: '.75rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          {expanded ? '⊖ 收起' : '⊕ 放大查看'}
        </button>
        <a
          href={url}
          download
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '.75rem', color: 'var(--primary)', textDecoration: 'none' }}>
          ⬇ 下载图片
        </a>
      </div>
    </div>
  );
}

// ─── GCS 文件下载块 ────────────────────────────────────────────────────────────
export function GcsFileBlock({ gcsPath, skillId }: { gcsPath: string; skillId: string }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const filename = gcsPath.split('/').pop() || 'file';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const isPdf = ext === 'pdf';
  const isImage = ['png','jpg','jpeg','webp','gif'].includes(ext);
  const fileIcon = isPdf ? '📄' : isImage ? '🖼️' : ['xlsx','csv'].includes(ext) ? '📊' : '📁';

  const fetchSignedUrl = async () => {
    if (signedUrl) return signedUrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}/signed-url?path=${encodeURIComponent(gcsPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get signed URL');
      setSignedUrl(data.signedUrl);
      return data.signedUrl as string;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--gray-200)', borderRadius: 8, padding: '10px 14px', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: '1.3rem' }}>{fileIcon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filename}</div>
          <div style={{ fontSize: '.72rem', color: 'var(--gray-400)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gcsPath}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {(isPdf || isImage) && (
            <button
              className="btn btn-sm"
              style={{ fontSize: '.78rem', background: 'transparent', border: '1px solid var(--gray-300)' }}
              onClick={async () => { await fetchSignedUrl(); setShowPreview(p => !p); }}>
              {showPreview ? '收起预览' : '👁 预览'}
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            style={{ fontSize: '.78rem' }}
            disabled={loading}
            onClick={async () => {
              const url = await fetchSignedUrl();
              if (url) {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }
            }}>
            {loading ? '⏳' : '⬇ 下载'}
          </button>
        </div>
      </div>
      {error && <div style={{ marginTop: 6, fontSize: '.78rem', color: '#dc2626' }}>❌ {error}</div>}
      {showPreview && signedUrl && (
        <div style={{ marginTop: 10 }}>
          {isPdf && (
            <iframe
              src={signedUrl}
              style={{ width: '100%', height: 500, border: 'none', borderRadius: 6, background: '#fff' }}
              title={filename}
            />
          )}
          {isImage && <ImageBlock url={signedUrl} />}
        </div>
      )}
    </div>
  );
}

// ─── HTML 沙盒渲染块 ───────────────────────────────────────────────────────────
export function HtmlBlock({ html }: { html: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: '.78rem', color: 'var(--gray-500)' }}>🌐 HTML 输出</span>
        <button onClick={() => setExpanded(!expanded)}
          style={{ fontSize: '.75rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {expanded ? '⊖ 收起' : '⊕ 展开渲染'}
        </button>
      </div>
      {expanded ? (
        <iframe
          srcDoc={html}
          sandbox="allow-scripts"
          style={{ width: '100%', height: 400, border: '1px solid var(--gray-200)', borderRadius: 6 }}
          title="HTML 输出"
        />
      ) : (
        <pre style={{ background: '#f8f9fa', borderRadius: 6, padding: '8px 12px', fontSize: '.78rem', maxHeight: 80, overflow: 'hidden', color: 'var(--gray-500)', margin: 0 }}>
          {html.slice(0, 200)}{html.length > 200 ? '…' : ''}
        </pre>
      )}
    </div>
  );
}

// ─── JSON 结构化卡片 ───────────────────────────────────────────────────────────
function JsonValue({ val, depth = 0 }: { val: any; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (val === null) return <span style={{ color: '#6b7280' }}>null</span>;
  if (typeof val === 'boolean') return <span style={{ color: '#7c3aed' }}>{String(val)}</span>;
  if (typeof val === 'number') return <span style={{ color: '#b45309' }}>{val}</span>;
  if (typeof val === 'string') {
    if (/^https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(val)) {
      return <ImageBlock url={val} />;
    }
    if (val.startsWith('gs://')) return <span style={{ color: '#0284c7', fontSize: '.82rem' }}>🗂 {val}</span>;
    return <span style={{ color: '#059669', wordBreak: 'break-all' }}>"{val}"</span>;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return <span style={{ color: '#6b7280' }}>[]</span>;
    return (
      <div>
        <button onClick={() => setOpen(!open)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: '.8rem', padding: 0 }}>
          {open ? '▼' : '▶'} Array [{val.length}]
        </button>
        {open && (
          <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--gray-200)', marginLeft: 4 }}>
            {val.map((item, i) => (
              <div key={i} style={{ margin: '3px 0' }}>
                <span style={{ color: 'var(--gray-400)', fontSize: '.78rem' }}>{i}: </span>
                <JsonValue val={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return <span style={{ color: '#6b7280' }}>{'{}'}</span>;
    return (
      <div>
        <button onClick={() => setOpen(!open)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: '.8rem', padding: 0 }}>
          {open ? '▼' : '▶'} Object {'{…}'}
        </button>
        {open && (
          <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--gray-200)', marginLeft: 4 }}>
            {keys.map(k => (
              <div key={k} style={{ margin: '4px 0', display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: '#1e40af', fontSize: '.82rem', flexShrink: 0 }}>{k}:</span>
                <JsonValue val={val[k]} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <span>{String(val)}</span>;
}

export function JsonCard({ data }: { data: any }) {
  const [rawMode, setRawMode] = useState(false);
  return (
    <div style={{ border: '1px solid var(--gray-200)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ background: '#f0f4ff', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--gray-200)' }}>
        <span style={{ fontSize: '.78rem', color: '#4338ca', fontWeight: 600 }}>{'{ }'} JSON 结构化输出</span>
        <button onClick={() => setRawMode(!rawMode)}
          style={{ marginLeft: 'auto', fontSize: '.73rem', color: 'var(--gray-500)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {rawMode ? '切换卡片视图' : '查看原始 JSON'}
        </button>
      </div>
      <div style={{ padding: '10px 14px', fontSize: '.83rem', maxHeight: 500, overflow: 'auto', lineHeight: 1.6 }}>
        {rawMode
          ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '.8rem' }}>{JSON.stringify(data, null, 2)}</pre>
          : <JsonValue val={data} depth={0} />
        }
      </div>
    </div>
  );
}

// ─── Markdown 转 HTML ─────────────────────────────────────────────────────────
function renderMd(text: string): string {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_,_l,code) =>
      `<pre style="background:#1e1e1e;color:#d4d4d4;border-radius:6px;padding:10px 12px;overflow:auto;font-size:.8rem;margin:8px 0">${code.replace(/</g,'&lt;')}</pre>`)
    .replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 4px;font-size:.9rem">$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3 style="margin:12px 0 6px;font-size:1rem">$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2 style="margin:14px 0 8px;font-size:1.1rem">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:.85em">$1</code>')
    .replace(/^\| .+/gm, line => {
      if (/^[\| \-:]+$/.test(line)) return '';
      const cells = line.split('|').slice(1,-1).map(c => `<td style="padding:5px 10px;border:1px solid #e2e8f0">${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .replace(/(<tr>.*<\/tr>\n?)+/gs, t => `<table style="border-collapse:collapse;width:100%;font-size:.83rem;margin:8px 0">${t}</table>`)
    .replace(/^- (.+)$/gm, '<li style="margin:2px 0">$1</li>')
    .replace(/(<li[^>]*>.*<\/li>\n?)+/gs, t => `<ul style="padding-left:18px;margin:6px 0">${t}</ul>`)
    .replace(/\n/g, '<br/>');
}

const hasMd = (t: string) => /^#{1,3} |\|.+\||\*\*|```|\n- |\n\d+\. /m.test(t);
const IMG_RE = /(https?:\/\/[^\s<>"]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s<>"]*)?)/gi;

// ─── 主组件 ───────────────────────────────────────────────────────────────────
export default function OutputRenderer({ text, skillId }: { text: string; skillId: string }) {
  if (!text.trim()) {
    return <pre style={{ color: 'var(--gray-400)', padding: 8, background: '#f9f9f9', borderRadius: 6, margin: 0 }}>(无输出)</pre>;
  }

  // 整体是 JSON
  try {
    const parsed = JSON.parse(text.trim());
    if (typeof parsed === 'object' && parsed !== null) return <JsonCard data={parsed} />;
  } catch { /* not json */ }

  // 逐行扫描切块
  const blocks: Array<{ type: string; content: string }> = [];
  let acc: string[] = [];
  const flush = () => { if (acc.length) { blocks.push({ type: 'text', content: acc.join('\n') }); acc = []; } };

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^gs:\/\/\S+/.test(t) || /^__GCS_FILE__:/.test(t)) {
      flush(); blocks.push({ type: 'gcs', content: t.replace(/^__GCS_FILE__:/, '') });
    } else if (/^__HTML__:/.test(t)) {
      flush(); blocks.push({ type: 'html', content: line.replace(/^__HTML__:/, '') });
    } else if (/^data:image\/[^;]+;base64,/.test(t) || /^__IMAGE_B64__:/.test(t)) {
      flush(); blocks.push({ type: 'img', content: t.replace(/^__IMAGE_B64__:/, '') });
    } else if (/^__IMAGE_URL__:https?:\/\//.test(t)) {
      flush(); blocks.push({ type: 'img', content: t.replace(/^__IMAGE_URL__:/, '') });
    } else {
      acc.push(line);
    }
  }
  flush();

  const renderText = (content: string, idx: number) => {
    const parts = content.split(IMG_RE);
    const hasImg = parts.length > 1;
    if (!hasImg) {
      return hasMd(content)
        ? <div key={idx} style={{ background: '#f8f9fa', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '10px 14px', fontSize: '.85rem', maxHeight: 600, overflow: 'auto', lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: renderMd(content) }} />
        : <pre key={idx} style={{ background: '#f8f9fa', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '10px 12px', fontSize: '.82rem', whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto', margin: 0 }}>{content}</pre>;
    }
    return (
      <div key={idx} style={{ fontSize: '.85rem', lineHeight: 1.7 }}>
        {parts.map((p, j) =>
          IMG_RE.test(p)
            ? <ImageBlock key={j} url={p} />
            : p.trim()
              ? hasMd(p) ? <div key={j} dangerouslySetInnerHTML={{ __html: renderMd(p) }} /> : <span key={j} style={{ whiteSpace: 'pre-wrap' }}>{p}</span>
              : null
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((b, i) => {
        if (b.type === 'text') return renderText(b.content, i);
        if (b.type === 'img')  return <ImageBlock key={i} url={b.content} />;
        if (b.type === 'gcs')  return <GcsFileBlock key={i} gcsPath={b.content} skillId={skillId} />;
        if (b.type === 'html') return <HtmlBlock key={i} html={b.content} />;
        return null;
      })}
    </div>
  );
}
