import express from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db';
import { processTicket } from '../aiProcessor';

export const resultRouter = express.Router();

const REPORTS_DIR = path.resolve(__dirname, '..', '..', '..', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─── POST /api/results/process/:ticketId ─────────────────────────────────────
// Trigger AI processing. Runs async (doesn't block response).
resultRouter.post('/process/:ticketId', async (req, res) => {
  try {
    const ticket = await db.getAsync<any>('SELECT id, status FROM tickets WHERE id=?', [req.params.ticketId]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!['submitted', 'done', 'error'].includes(ticket.status))
      return res.status(400).json({ error: `Ticket status is "${ticket.status}", must be submitted/done/error to reprocess` });

    // Respond immediately, process in background
    res.json({ message: 'Processing started', ticket_id: ticket.id });

    // Run async (non-blocking)
    processTicket(ticket.id).catch(err => {
      console.error(`[Processor] Ticket ${ticket.id} failed:`, err.message);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:ticketId ───────────────────────────────────────────────
resultRouter.get('/:ticketId', async (req, res) => {
  try {
    const result = await db.getAsync<any>('SELECT * FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
    if (!result) return res.status(404).json({ error: 'No result yet' });
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/results/:ticketId ───────────────────────────────────────────────
// Staff saves revised result + notes
resultRouter.put('/:ticketId', async (req, res) => {
  try {
    const { revised_result, revision_notes, revised_by } = req.body;
    const existing = await db.getAsync<any>('SELECT id, ticket_id FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
    if (!existing) return res.status(404).json({ error: 'No result to revise' });

    const now = Date.now();
    await db.runAsync(
      `UPDATE ticket_results SET revised_result=?, revision_notes=?, revised_by=?, revised_at=?, updated_at=? WHERE ticket_id=?`,
      [revised_result || null, revision_notes || null, revised_by || null, now, now, req.params.ticketId]
    );

    // Save revision memory for future retraining
    if (revised_result) {
      const original = await db.getAsync<any>('SELECT raw_result FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
      const ticket = await db.getAsync<any>('SELECT skill_id FROM tickets WHERE id=?', [req.params.ticketId]);
      await db.runAsync(
        `INSERT INTO revision_memories (id, skill_id, ticket_id, original_output, revised_output, revision_notes, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), ticket?.skill_id, req.params.ticketId,
         original?.raw_result || null, revised_result, revision_notes || null, now]
      );
    }

    const updated = await db.getAsync<any>('SELECT * FROM ticket_results WHERE ticket_id=?', [req.params.ticketId]);
    res.json({ result: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/results/:ticketId/report ───────────────────────────────────────
// Generate and download report as HTML (puppeteer-core PDF optional)
resultRouter.get('/:ticketId/report', async (req, res) => {
  try {
    const format = (req.query.format as string) || 'html';
    const ticket = await db.getAsync<any>('SELECT * FROM tickets WHERE id=?', [req.params.ticketId]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const result = await db.getAsync<any>('SELECT * FROM ticket_results WHERE ticket_id=?', [ticket.id]);
    if (!result) return res.status(404).json({ error: 'No result available' });

    const skill = await db.getAsync<any>('SELECT name FROM skills WHERE id=?', [ticket.skill_id]);
    const content = result.revised_result || result.raw_result;
    const date = new Date(ticket.updated_at).toLocaleDateString('zh-CN');
    const time = new Date(ticket.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Convert markdown-like content to basic HTML
    const contentHtml = content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,3}\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/gs, (m: string) => `<ul>${m}</ul>`)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>')
      .replace(/^(?!<)(.+)$/gm, '$1');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>${skill?.name || '报告'} — ${ticket.patient_name || '患者'}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Noto Serif SC', 'Songti SC', serif; background: #fff; color: #1a1a1a; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.9; }
  .report-header { border-bottom: 2px solid #1a1a1a; padding-bottom: 20px; margin-bottom: 28px; }
  .report-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .report-meta { font-size: 13px; color: #666; display: flex; gap: 24px; flex-wrap: wrap; margin-top: 10px; }
  .report-meta span::before { content: attr(data-label) '：'; font-weight: 600; color: #333; }
  .report-body { font-size: 15px; }
  .report-body h3 { font-size: 16px; font-weight: 700; margin: 20px 0 8px; color: #111; border-left: 3px solid #2563eb; padding-left: 10px; }
  .report-body p { margin-bottom: 10px; }
  .report-body ul { padding-left: 20px; margin-bottom: 10px; }
  .report-body li { margin-bottom: 4px; }
  .report-body strong { color: #111; }
  .report-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #999; display: flex; justify-content: space-between; }
  .watermark { color: #2563eb; font-weight: 700; }
  ${result.revised_result ? '.revised-badge { display: inline-block; background: #f0fdf4; color: #16a34a; border: 1px solid #86efac; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-style: normal; margin-left: 8px; }' : ''}
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <div class="report-header">
    <div class="report-title">
      ${skill?.name || 'AI 分析报告'}
      ${result.revised_result ? '<em class="revised-badge">医生审阅版</em>' : ''}
    </div>
    <div class="report-meta">
      <span data-label="患者">${ticket.patient_name || '—'}</span>
      <span data-label="手机">${ticket.patient_phone || '—'}</span>
      <span data-label="报告日期">${date} ${time}</span>
      ${result.revised_by ? `<span data-label="审阅医生">${result.revised_by}</span>` : ''}
    </div>
  </div>
  <div class="report-body">
    <p>${contentHtml}</p>
  </div>
  <div class="report-footer">
    <span>本报告由 <span class="watermark">Skill Platform</span> AI 系统生成</span>
    <span>生成时间：${date} ${time}</span>
  </div>
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
        const executablePath = CHROME_PATHS.find(p => fs.existsSync(p));
        if (!executablePath) throw new Error('Chrome not found');

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
      } catch (pdfErr: any) {
        console.warn('[PDF] Falling back to HTML:', pdfErr.message);
      }
    }

    // Return HTML inline (open in browser → Ctrl+P to print as PDF)
    const filename = `report_${ticket.patient_name || 'report'}_${date.replace(/\//g, '-')}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // inline so browser opens it instead of downloading
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
