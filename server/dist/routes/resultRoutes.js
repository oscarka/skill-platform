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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resultRouter = void 0;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const db = __importStar(require("../db"));
const aiProcessor_1 = require("../aiProcessor");
const agentService_1 = require("../agentService");
const marked_1 = require("marked");
exports.resultRouter = express_1.default.Router();
const REPORTS_DIR = path_1.default.resolve(__dirname, '..', '..', '..', 'reports');
if (!fs_1.default.existsSync(REPORTS_DIR))
    fs_1.default.mkdirSync(REPORTS_DIR, { recursive: true });
// ─── POST /api/results/process/:ticketId ─────────────────────────────────────
// Trigger AI processing. Runs async (doesn't block response).
// Body: { override_model?: string } — optional model override for testing
exports.resultRouter.post('/process/:ticketId', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT id, status FROM tickets WHERE id=?', [req.params.ticketId]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        if (!['submitted', 'done', 'error'].includes(ticket.status))
            return res.status(400).json({ error: `Ticket status is "${ticket.status}", must be submitted/done/error to reprocess` });
        const overrideModel = req.body?.override_model || undefined;
        if (overrideModel) {
            console.log(`[Processor] Ticket ${ticket.id} reprocess with overrideModel=${overrideModel}`);
        }
        // Respond immediately, process in background
        res.json({ message: 'Processing started', ticket_id: ticket.id, override_model: overrideModel || null });
        // Run async (non-blocking)
        (0, aiProcessor_1.processTicket)(ticket.id, undefined, { overrideModel }).catch(err => {
            console.error(`[Processor] Ticket ${ticket.id} failed:`, err.message);
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/results/:ticketId ───────────────────────────────────────────────
exports.resultRouter.get('/:ticketId', async (req, res) => {
    try {
        const result = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
        if (!result)
            return res.status(404).json({ error: 'No result yet' });
        res.json({ result });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── PUT /api/results/:ticketId ───────────────────────────────────────────────
// Staff saves revised result + notes
exports.resultRouter.put('/:ticketId', async (req, res) => {
    try {
        const { revised_result, revision_notes, revised_by } = req.body;
        const existing = await db.getAsync('SELECT id, ticket_id FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
        if (!existing)
            return res.status(404).json({ error: 'No result to revise' });
        const now = Date.now();
        await db.runAsync(`UPDATE ticket_results SET revised_result=?, revision_notes=?, revised_by=?, revised_at=?, updated_at=? WHERE ticket_id=?`, [revised_result || null, revision_notes || null, revised_by || null, now, now, req.params.ticketId]);
        // Save revision memory for future retraining
        if (revised_result) {
            const original = await db.getAsync('SELECT raw_result FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
            const ticket = await db.getAsync('SELECT skill_id FROM tickets WHERE id=?', [req.params.ticketId]);
            await db.runAsync(`INSERT INTO revision_memories (id, skill_id, ticket_id, original_output, revised_output, revision_notes, created_at)
         VALUES (?,?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket?.skill_id, req.params.ticketId,
                original?.raw_result || null, revised_result, revision_notes || null, now]);
        }
        const updated = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
        res.json({ result: updated });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/results/:ticketId/report ───────────────────────────────────────
// Generate and download report as HTML (puppeteer-core PDF optional)
exports.resultRouter.get('/:ticketId/report', async (req, res) => {
    try {
        const format = req.query.format || 'html';
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.ticketId]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const result = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [ticket.id]);
        if (!result)
            return res.status(404).json({ error: 'No result available' });
        const skill = await db.getAsync('SELECT name FROM skills WHERE id=?', [ticket.skill_id]);
        const rawContent = result.revised_result || result.raw_result || '';
        const date = new Date(ticket.updated_at).toLocaleDateString('zh-CN');
        const time = new Date(ticket.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        // Configure marked: GFM (tables, strikethrough) + smart line breaks
        marked_1.marked.setOptions({ gfm: true, breaks: true });
        const contentHtml = marked_1.marked.parse(rawContent);
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${skill?.name || '报告'} — ${ticket.patient_name || '患者'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=Noto+Sans+SC:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
  /* ─── Reset & Base ─────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --blue:    #1d4ed8;
    --blue-lt: #eff6ff;
    --green:   #15803d;
    --green-lt:#f0fdf4;
    --amber:   #b45309;
    --amber-lt:#fffbeb;
    --red:     #b91c1c;
    --red-lt:  #fef2f2;
    --gray:    #374151;
    --gray-lt: #f9fafb;
    --border:  #e5e7eb;
    --text:    #111827;
    --muted:   #6b7280;
    --radius:  6px;
    --serif:   'Noto Serif SC', 'Songti SC', 'STSong', serif;
    --sans:    'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }

  /* ─── Page ─────────────────────────────────────────────── */
  body {
    font-family: var(--serif);
    font-size: 15px;
    line-height: 1.85;
    color: var(--text);
    background: #f3f4f6;
    padding: 32px 16px 60px;
  }
  .page {
    background: #fff;
    max-width: 820px;
    margin: 0 auto;
    padding: 48px 56px 56px;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06);
  }

  /* ─── Header ───────────────────────────────────────────── */
  .rpt-header {
    border-bottom: 2px solid var(--text);
    padding-bottom: 20px;
    margin-bottom: 32px;
  }
  .rpt-badge {
    display: inline-block;
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--blue);
    background: var(--blue-lt);
    border: 1px solid #bfdbfe;
    border-radius: 4px;
    padding: 2px 8px;
    margin-bottom: 10px;
  }
  .rpt-title {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -.02em;
    color: var(--text);
    line-height: 1.3;
    margin-bottom: 14px;
  }
  .rpt-revised {
    display: inline-block;
    font-size: 11px;
    font-style: normal;
    font-family: var(--sans);
    font-weight: 600;
    color: var(--green);
    background: var(--green-lt);
    border: 1px solid #86efac;
    border-radius: 4px;
    padding: 1px 7px;
    margin-left: 10px;
    vertical-align: middle;
  }
  .rpt-meta {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 6px 24px;
  }
  .rpt-meta-item { display: flex; gap: 4px; }
  .rpt-meta-label { color: var(--gray); font-weight: 600; }

  /* ─── Body ─────────────────────────────────────────────── */
  .rpt-body { font-size: 15px; color: var(--text); }

  .rpt-body h1, .rpt-body h2, .rpt-body h3,
  .rpt-body h4, .rpt-body h5 {
    font-family: var(--sans);
    font-weight: 700;
    line-height: 1.4;
    margin: 28px 0 10px;
    color: var(--text);
  }
  .rpt-body h1 { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  .rpt-body h2 {
    font-size: 16px;
    color: #1e3a8a;
    border-left: 4px solid var(--blue);
    padding-left: 12px;
    margin-left: -16px;
  }
  .rpt-body h3 { font-size: 14.5px; color: var(--gray); }
  .rpt-body h4 { font-size: 14px; color: var(--muted); font-weight: 600; }

  .rpt-body p { margin-bottom: 12px; }
  .rpt-body strong { font-weight: 700; color: var(--text); }
  .rpt-body em { color: var(--muted); }
  .rpt-body a { color: var(--blue); text-decoration: underline; }
  .rpt-body hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }

  /* ─── Lists ─────────────────────────────────────────────── */
  .rpt-body ul, .rpt-body ol {
    padding-left: 22px;
    margin-bottom: 12px;
  }
  .rpt-body li { margin-bottom: 5px; padding-left: 2px; }
  .rpt-body ul li::marker { color: var(--blue); }

  /* ─── Blockquote ────────────────────────────────────────── */
  .rpt-body blockquote {
    border-left: 4px solid var(--border);
    padding: 10px 16px;
    margin: 16px 0;
    color: var(--muted);
    background: var(--gray-lt);
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  /* ─── Code ──────────────────────────────────────────────── */
  .rpt-body code {
    font-family: 'Menlo', 'Monaco', monospace;
    font-size: 13px;
    background: var(--gray-lt);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
  }
  .rpt-body pre {
    background: #1e293b;
    color: #e2e8f0;
    border-radius: var(--radius);
    padding: 16px;
    overflow-x: auto;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .rpt-body pre code {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
  }

  /* ─── Tables ────────────────────────────────────────────── */
  .rpt-body table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0 24px;
    font-family: var(--sans);
    font-size: 13.5px;
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--border);
  }
  .rpt-body thead {
    background: #1e3a8a;
    color: #fff;
  }
  .rpt-body thead th {
    padding: 11px 14px;
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
    letter-spacing: .02em;
    font-size: 12.5px;
  }
  .rpt-body tbody tr:nth-child(even) { background: #f8fafc; }
  .rpt-body tbody tr:hover { background: #eff6ff; transition: background .15s; }
  .rpt-body td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    line-height: 1.65;
  }
  .rpt-body tbody tr:last-child td { border-bottom: none; }

  /* ─── Risk level coloring (auto-detect cell text) ───────── */
  .rpt-body td:first-child:not(:only-child) {
    font-weight: 600;
    font-size: 13px;
  }
  /* Detect risk level via attribute selector on data-text + JS injection below */
  .risk-high { color: var(--red)  !important; background: var(--red-lt) !important; }
  .risk-mid  { color: var(--amber)!important; background: var(--amber-lt)!important; }
  .risk-low  { color: var(--green)!important; background: var(--green-lt)!important; }

  /* ─── Footer ────────────────────────────────────────────── */
  .rpt-footer {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--muted);
    gap: 12px;
    flex-wrap: wrap;
  }
  .rpt-footer-brand { color: var(--blue); font-weight: 700; }
  .rpt-disclaimer {
    font-size: 11px;
    color: var(--muted);
    margin-top: 10px;
    font-family: var(--sans);
    font-style: italic;
    line-height: 1.6;
  }

  /* ─── Print ─────────────────────────────────────────────── */
  @media print {
    body { background: #fff; padding: 0; }
    .page { box-shadow: none; border-radius: 0; padding: 24px 32px; }
    .rpt-body table { box-shadow: none; border: 1px solid var(--border); }
    .rpt-body thead { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .rpt-body tbody tr:nth-child(even) { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .risk-high, .risk-mid, .risk-low { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media (max-width: 640px) {
    .page { padding: 24px 20px; }
    .rpt-body h2 { margin-left: 0; }
    .rpt-body table { font-size: 12px; }
    .rpt-body td, .rpt-body thead th { padding: 8px 10px; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="rpt-header">
    <div class="rpt-badge">AI 健康分析报告</div>
    <div class="rpt-title">
      ${skill?.name || 'AI 分析报告'}
      ${result.revised_result ? '<em class="rpt-revised">医生审阅版</em>' : ''}
    </div>
    <div class="rpt-meta">
      ${ticket.patient_name ? `<div class="rpt-meta-item"><span class="rpt-meta-label">受检人</span><span>${ticket.patient_name}</span></div>` : ''}
      ${ticket.patient_phone ? `<div class="rpt-meta-item"><span class="rpt-meta-label">联系电话</span><span>${ticket.patient_phone}</span></div>` : ''}
      <div class="rpt-meta-item"><span class="rpt-meta-label">报告时间</span><span>${date} ${time}</span></div>
      ${result.revised_by ? `<div class="rpt-meta-item"><span class="rpt-meta-label">审阅医生</span><span>${result.revised_by}</span></div>` : ''}
    </div>
  </div>

  <div class="rpt-body">
    ${contentHtml}
  </div>

  <div class="rpt-footer">
    <span>本报告由 <span class="rpt-footer-brand">Skill Platform</span> AI 系统生成</span>
    <span>生成时间：${date} ${time}</span>
  </div>
  <div class="rpt-disclaimer">
    ⚠️ 本报告仅供健康信息参考，不替代医生诊断、处方或治疗建议。如有疑虑请及时就医。
  </div>

  ${ticket.status === 'done' ? `
  <div id="confirm-section" style="margin-top:32px;padding:20px 24px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;font-family:var(--sans);text-align:center;">
    <p style="margin-bottom:16px;font-size:14px;color:#374151;font-weight:500;">请确认报告内容是否符合您的情况，确认后将存入您的健康档案。</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
      <button id="btn-confirm" onclick="confirmReport()" style="padding:11px 32px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--sans);transition:opacity .15s;">✅ 确认报告内容</button>
      <button id="btn-reject" onclick="rejectReport()" style="padding:11px 32px;background:#fff;color:#dc2626;border:2px solid #dc2626;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--sans);transition:opacity .15s;">❌ 内容有误，不认可</button>
    </div>
    <p id="confirm-msg" style="margin-top:12px;font-size:13px;color:#6b7280;"></p>
  </div>` : ticket.status === 'patient_confirmed' ? `
  <div style="margin-top:32px;padding:16px 24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-family:var(--sans);text-align:center;color:#15803d;font-weight:600;">✅ 您已确认此报告，内容已存入健康档案</div>` : ticket.status === 'patient_rejected' ? `
  <div style="margin-top:32px;padding:16px 24px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-family:var(--sans);text-align:center;color:#dc2626;font-weight:600;">❌ 您已标记此报告内容有误，工作人员将跟进</div>` : ''}

</div>

<script>
  // Auto-color risk level cells
  document.querySelectorAll('tbody tr').forEach(tr => {
    const firstTd = tr.querySelector('td:first-child');
    if (!firstTd) return;
    const txt = firstTd.textContent.trim();
    if (/高风险|高危/.test(txt)) firstTd.classList.add('risk-high');
    else if (/中风险|中危/.test(txt)) firstTd.classList.add('risk-mid');
    else if (/低风险|低危/.test(txt)) firstTd.classList.add('risk-low');
  });

  function setLoading(loading) {
    document.getElementById('btn-confirm').disabled = loading;
    document.getElementById('btn-reject').disabled = loading;
    document.getElementById('btn-confirm').style.opacity = loading ? '0.5' : '1';
    document.getElementById('btn-reject').style.opacity = loading ? '0.5' : '1';
  }

  async function confirmReport() {
    if (!confirm('确认后报告将存入您的健康档案，确定吗？')) return;
    setLoading(true);
    document.getElementById('confirm-msg').textContent = '正在提交…';
    try {
      const r = await fetch('/api/results/${req.params.ticketId}/confirm', { method: 'POST' });
      const d = await r.json();
      if (r.ok) {
        document.getElementById('confirm-section').innerHTML = '<div style="color:#15803d;font-weight:600;">✅ 已确认！报告已存入您的健康档案。</div>';
      } else {
        document.getElementById('confirm-msg').textContent = '提交失败：' + (d.error || '未知错误');
        setLoading(false);
      }
    } catch(e) {
      document.getElementById('confirm-msg').textContent = '网络错误，请重试';
      setLoading(false);
    }
  }

  async function rejectReport() {
    if (!confirm('标记为内容有误？')) return;
    setLoading(true);
    document.getElementById('confirm-msg').textContent = '正在提交…';
    try {
      const r = await fetch('/api/results/${req.params.ticketId}/reject', { method: 'POST' });
      const d = await r.json();
      if (r.ok) {
        document.getElementById('confirm-section').innerHTML = '<div style="color:#dc2626;font-weight:600;">❌ 已标记内容有误，工作人员将跟进处理。</div>';
      } else {
        document.getElementById('confirm-msg').textContent = '提交失败：' + (d.error || '未知错误');
        setLoading(false);
      }
    } catch(e) {
      document.getElementById('confirm-msg').textContent = '网络错误，请重试';
      setLoading(false);
    }
  }
</script>
</body>
</html>`;
        if (format === 'pdf') {
            // Try puppeteer-core with system Chrome
            try {
                const puppeteer = require('puppeteer-core');
                const CHROME_PATHS = [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
                ];
                const executablePath = CHROME_PATHS.find(p => fs_1.default.existsSync(p));
                if (!executablePath)
                    throw new Error('Chrome not found');
                const browser = await puppeteer.launch({
                    executablePath, headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                });
                const page = await browser.newPage();
                await page.setContent(html, { waitUntil: 'networkidle0' });
                const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' }, printBackground: true });
                await browser.close();
                const filename = `report_${ticket.id.slice(0, 8)}_${Date.now()}.pdf`;
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                return res.send(pdfBuffer);
            }
            catch (pdfErr) {
                console.warn('[PDF] Falling back to HTML:', pdfErr.message);
            }
        }
        // Return HTML inline (open in browser → Ctrl+P to print as PDF)
        const filename = `report_${ticket.patient_name || 'report'}_${date.replace(/\//g, '-')}.html`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
        res.send(html);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── POST /api/results/:ticketId/confirm ─────────────────────────────────────
// Patient confirms report → status=patient_confirmed + write to LLMWiki
exports.resultRouter.post('/:ticketId/confirm', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.ticketId]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        if (ticket.status !== 'done')
            return res.status(400).json({ error: `Cannot confirm: ticket status is "${ticket.status}", must be "done"` });
        const result = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [ticket.id]);
        if (!result)
            return res.status(400).json({ error: 'No result to confirm' });
        const skill = await db.getAsync('SELECT name FROM skills WHERE id=?', [ticket.skill_id]);
        // Update ticket status
        await db.runAsync(`UPDATE tickets SET status='patient_confirmed', updated_at=? WHERE id=?`, [Date.now(), ticket.id]);
        res.json({ success: true, message: '报告已确认，正在写入健康档案' });
        // Async: write to LLMWiki (non-blocking)
        const userId = ticket.created_by;
        if (userId) {
            const content = result.revised_result || result.raw_result || '';
            const skillName = skill?.name || 'AI分析';
            const logContent = `【${skillName}报告 - 患者已确认】\n\n${content}`;
            try {
                await (0, agentService_1.writeWikiLog)(userId, logContent, 'ai_report', `${skillName}分析报告（患者确认版）`);
                console.log(`[Confirm] 报告写入 LLMWiki log: userId=${userId}`);
                (0, agentService_1.triggerWikiSyncPublic)(userId, `patient_confirmed_${ticket.id}`);
                console.log(`[Confirm] 触发 Wiki sync: userId=${userId}`);
            }
            catch (e) {
                console.error(`[Confirm] LLMWiki write failed for userId=${userId}:`, e.message);
            }
        }
        else {
            console.log(`[Confirm] 跳过 Wiki sync: ticket ${ticket.id} 无 created_by`);
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── POST /api/results/:ticketId/reject ──────────────────────────────────────
// Patient rejects report → status=patient_rejected (no wiki write)
exports.resultRouter.post('/:ticketId/reject', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT id, status FROM tickets WHERE id=?', [req.params.ticketId]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        if (ticket.status !== 'done')
            return res.status(400).json({ error: `Cannot reject: ticket status is "${ticket.status}", must be "done"` });
        await db.runAsync(`UPDATE tickets SET status='patient_rejected', updated_at=? WHERE id=?`, [Date.now(), ticket.id]);
        res.json({ success: true, message: '已标记报告内容有误' });
        console.log(`[Reject] Ticket ${ticket.id} marked as patient_rejected`);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
