// ============================================================
// api/prompt-report.js — MentorAI Prompt Analysis Report
// ============================================================
// Sends daily highlights email to founders
// Full data available in Supabase — filter by "issue" column
// Runs at 7:30 AM IST (2:00 AM UTC)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.REPORT_EMAIL_FROM;
const TO_EMAILS    = (process.env.REPORT_EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
const CRON_SECRET  = process.env.CRON_SECRET;

// ── Supabase query helper ────────────────────────────────────
async function query(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json'
    }
  });
  if (!res.ok) {
    console.warn(`[PROMPT-REPORT] Supabase query failed`);
    return [];
  }
  return res.json().catch(() => []);
}

// ── Get yesterday's date range in IST ───────────────────────
function getYesterdayIST() {
  const now       = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);

  const start = new Date(istNow);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(istNow);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);

  const startUTC = new Date(start.getTime() - istOffset).toISOString();
  const endUTC   = new Date(end.getTime()   - istOffset).toISOString();

  const dateLabel = start.toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Kolkata'
  });

  return { startUTC, endUTC, dateLabel };
}

// ── Build highlights-only HTML email ────────────────────────
function buildEmailHTML(data, dateLabel) {
  const {
    totalMessages, totalConversations, cleanConversations,
    issueConversations, issueBreakdown, topIssueMessages,
    subjectsWithNoRAG, profiles
  } = data;

  // Issue breakdown rows
  const issueRows = Object.entries(issueBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([issue, count]) => {
      const emoji = {
        'No RAG content':    '⚠️',
        'Student confused':  '🔄',
        'Short AI response': '📉',
      }[issue] || '🔴';
      return `<tr>
        <td style="padding:8px 12px;font-size:14px;color:#e2e8f0">${emoji} ${issue}</td>
        <td style="padding:8px 12px;font-size:14px;color:#f59e0b;text-align:center;font-weight:600">${count}</td>
      </tr>`;
    }).join('');

  // Top flagged messages — show only user query + issue, no full AI response
  const flaggedRows = topIssueMessages.slice(0, 10).map(msg => {
    const profile = profiles.find(p => p.id === msg.user_id);
    const name    = profile?.name || 'Unknown';
    return `
      <div style="background:#1a1a2e;border-left:3px solid #f59e0b;border-radius:0 8px 8px 0;padding:12px 16px;margin:8px 0">
        <div style="font-size:11px;color:#64748b;margin-bottom:4px">
          👤 ${name} 
          ${msg.subject ? `· 📚 ${msg.subject}` : ''}
          ${msg.mode && msg.mode !== 'teaching' ? `· 🎯 ${msg.mode}` : ''}
        </div>
        <div style="font-size:13px;color:#e2e8f0;margin-bottom:6px">"${(msg.content || '').slice(0, 200)}"</div>
        <div style="font-size:12px;color:#f59e0b">⚡ ${msg.issue}</div>
      </div>`;
  }).join('');

  // Subjects with no RAG
  const ragSubjectRows = subjectsWithNoRAG.length > 0
    ? subjectsWithNoRAG.map(s =>
        `<li style="margin:4px 0;color:#e2e8f0">${s.subject} — <strong style="color:#ef4444">${s.count} queries with no content</strong></li>`
      ).join('')
    : '<li style="color:#22c55e">All subjects had RAG content ✅</li>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
<div style="max-width:680px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#f59e0b,#ef4444);border-radius:16px;padding:28px;margin-bottom:20px;text-align:center">
    <div style="font-size:28px;margin-bottom:6px">🔬</div>
    <h1 style="margin:0;font-size:20px;color:#fff;font-weight:700">Prompt Analysis Report</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px">${dateLabel}</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.65);font-size:11px">Full data available in Supabase → chat_messages → filter by "issue" column</p>
  </div>

  <!-- Top Line -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">📊 Yesterday at a Glance</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
      ${[
        ['Total Messages',    totalMessages,        '#4ecdc4'],
        ['Conversations',     totalConversations,   '#4ecdc4'],
        ['✅ Clean',          cleanConversations,   '#22c55e'],
        ['⚠️ With Issues',   issueConversations,   '#f59e0b']
      ].map(([label, value, color]) => `
        <div style="background:#0f0f1a;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:${color}">${value}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px">${label}</div>
        </div>`).join('')}
    </div>
  </div>

  <!-- Issue Breakdown -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">⚡ Issue Breakdown</h2>
    ${Object.keys(issueBreakdown).length > 0 ? `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:1px solid #2d2d44">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:12px;font-weight:500">Issue Type</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-size:12px;font-weight:500">Count</th>
        </tr>
      </thead>
      <tbody>${issueRows}</tbody>
    </table>` : '<p style="color:#22c55e;font-size:14px;margin:0">✅ No issues detected yesterday</p>'}
  </div>

  <!-- Subjects With No RAG -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">📚 Subjects Needing More PDFs</h2>
    <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.8">
      ${ragSubjectRows}
    </ul>
  </div>

  <!-- Top Flagged Messages -->
  ${topIssueMessages.length > 0 ? `
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">🔴 Top Flagged Messages</h2>
    <p style="margin:0 0 12px;font-size:12px;color:#64748b">Showing up to 10 messages that had issues. Full list in Supabase.</p>
    ${flaggedRows}
  </div>` : ''}

  <!-- Action Items -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">🛠️ Action Items for Prompt Engineer</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:2;color:#e2e8f0">
      ${subjectsWithNoRAG.length > 0
        ? subjectsWithNoRAG.map(s => `<li>Ingest more <strong>${s.subject}</strong> PDFs into Pinecone (${s.count} failed queries)</li>`).join('')
        : '<li style="color:#22c55e">✅ RAG coverage looks good</li>'}
      ${issueBreakdown['Student confused'] > 0
        ? `<li>Review explanation prompts — ${issueBreakdown['Student confused']} student(s) asked to explain again</li>`
        : ''}
      ${issueBreakdown['Short AI response'] > 0
        ? `<li>Check for prompt failures — ${issueBreakdown['Short AI response']} very short AI response(s) detected</li>`
        : ''}
      <li style="color:#64748b">→ Go to Supabase → chat_messages → filter <strong>issue</strong> column for full analysis</li>
    </ul>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px;color:#475569;font-size:12px">
    MentorAI — Prompt Analysis Report &nbsp;|&nbsp; mentor-ai-swart.vercel.app
  </div>

</div>
</body>
</html>`;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (CRON_SECRET) {
    const querySecret  = req.query?.secret;
    const headerSecret = req.headers['x-cron-secret'];
    const authHeader   = req.headers.authorization;
    if (querySecret !== CRON_SECRET && headerSecret !== CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const { startUTC, endUTC, dateLabel } = getYesterdayIST();

    console.log('[PROMPT-REPORT] Generating for:', dateLabel);

    const [messages, profiles] = await Promise.all([
      query('chat_messages', `?created_at=gte.${startUTC}&created_at=lte.${endUTC}&select=*&order=created_at.asc`),
      query('user_profiles', `?select=id,name`)
    ]);

    // Only user messages with issues
    const userMessages    = messages.filter(m => m.role === 'user');
    const assistantMsgs   = messages.filter(m => m.role === 'assistant');
    const messagesWithIssue = messages.filter(m => m.issue && m.issue.trim() !== '');

    // Unique conversations
    const allUserIds      = [...new Set(messages.map(m => m.user_id))];
    const issueUserIds    = [...new Set(messagesWithIssue.map(m => m.user_id))];
    const cleanConvs      = allUserIds.filter(id => !issueUserIds.includes(id)).length;

    // Issue breakdown
    const issueBreakdown  = {};
    messagesWithIssue.forEach(m => {
      const parts = (m.issue || '').split(' | ');
      parts.forEach(issue => {
        issueBreakdown[issue] = (issueBreakdown[issue] || 0) + 1;
      });
    });

    // Subjects with no RAG — from assistant messages
    const noRagMessages   = assistantMsgs.filter(m => m.rag_hit === false && m.subject);
    const subjectCounts   = {};
    noRagMessages.forEach(m => {
      subjectCounts[m.subject] = (subjectCounts[m.subject] || 0) + 1;
    });
    const subjectsWithNoRAG = Object.entries(subjectCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([subject, count]) => ({ subject, count }));

    // Top flagged user messages only (not assistant)
    const topIssueMessages = messagesWithIssue
      .filter(m => m.role === 'user')
      .slice(0, 10);

    const data = {
      totalMessages:       messages.length,
      totalConversations:  allUserIds.length,
      cleanConversations:  cleanConvs,
      issueConversations:  issueUserIds.length,
      issueBreakdown,
      topIssueMessages,
      subjectsWithNoRAG,
      profiles
    };

    const html = buildEmailHTML(data, dateLabel);

    if (!RESEND_KEY || TO_EMAILS.length === 0) {
      return res.status(200).send(html);
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      TO_EMAILS,
        subject: `🔬 Prompt Analysis — ${dateLabel}`,
        html
      })
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('[PROMPT-REPORT] Email failed:', emailData);
      return res.status(500).json({ error: 'Email failed', details: emailData });
    }

    console.log('[PROMPT-REPORT] Sent to:', TO_EMAILS.join(', '));
    return res.status(200).json({
      success: true,
      date:    dateLabel,
      stats: {
        totalMessages:      messages.length,
        totalConversations: allUserIds.length,
        cleanConversations: cleanConvs,
        issueConversations: issueUserIds.length,
        topIssues:          Object.keys(issueBreakdown).length
      }
    });

  } catch (err) {
    console.error('[PROMPT-REPORT] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
