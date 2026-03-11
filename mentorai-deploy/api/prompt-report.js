// ============================================================
// api/prompt-report.js — MentorAI Prompt Analysis Report
// ============================================================
// Sends daily prompt quality report to founders
// Shows every conversation with full context so you can
// identify where prompts are failing and fix them
// Runs at 7:30 AM IST (2:00 AM UTC) — 30 mins after main report
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
    const err = await res.text();
    console.warn(`[PROMPT-REPORT] Supabase query failed:`, err);
    return [];
  }
  return res.json().catch(() => []);
}

// ── Get yesterday's date range in IST ───────────────────────
function getYesterdayIST() {
  const now = new Date();
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

// ── Group messages into conversations by user ────────────────
function groupIntoConversations(messages, profiles) {
  const byUser = {};

  messages.forEach(msg => {
    if (!byUser[msg.user_id]) {
      const profile = profiles.find(p => p.id === msg.user_id);
      byUser[msg.user_id] = {
        userId:   msg.user_id,
        name:     profile?.name || 'Unknown Student',
        messages: []
      };
    }
    byUser[msg.user_id].messages.push(msg);
  });

  // Sort messages within each conversation by time
  Object.values(byUser).forEach(conv => {
    conv.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  });

  return Object.values(byUser);
}

// ── Identify problem patterns in a conversation ──────────────
function analyzeConversation(messages) {
  const issues = [];

  const userMsgs      = messages.filter(m => m.role === 'user');
  const assistantMsgs = messages.filter(m => m.role === 'assistant');

  // Pattern 1: No RAG hit — AI used general knowledge
  const noRagHits = assistantMsgs.filter(m => m.rag_hit === false);
  if (noRagHits.length > 0) {
    issues.push({
      type:  '⚠️ No RAG Content',
      detail: `${noRagHits.length} AI response(s) had no knowledge base content — AI used general knowledge`
    });
  }

  // Pattern 2: Repeated questions — student didn't understand
  const contents = userMsgs.map(m => (m.content || '').toLowerCase());
  const repeatSignals = contents.filter(c =>
    c.includes('again') || c.includes('dont understand') ||
    c.includes("don't understand") || c.includes('explain again') ||
    c.includes('still confused') || c.includes('not clear')
  );
  if (repeatSignals.length > 0) {
    issues.push({
      type:   '🔄 Student Confused',
      detail: `Student asked for re-explanation ${repeatSignals.length} time(s) — prompt may not be explaining clearly enough`
    });
  }

  // Pattern 3: Negative emotion detected
  const negativeEmotions = messages.filter(m =>
    ['panicked','frustrated','anxious','stressed'].includes(m.emotion)
  );
  if (negativeEmotions.length > 0) {
    issues.push({
      type:   '😰 Negative Emotion',
      detail: `Detected: ${[...new Set(negativeEmotions.map(m => m.emotion))].join(', ')}`
    });
  }

  // Pattern 4: Short AI responses (possible prompt failure)
  const shortResponses = assistantMsgs.filter(m => (m.content || '').length < 100);
  if (shortResponses.length > 0) {
    issues.push({
      type:   '📉 Short AI Response',
      detail: `${shortResponses.length} very short response(s) — may indicate prompt confusion`
    });
  }

  return issues;
}

// ── Build HTML email ─────────────────────────────────────────
function buildEmailHTML(conversations, dateLabel, stats) {

  const conversationBlocks = conversations.map((conv, idx) => {
    const issues  = analyzeConversation(conv.messages);
    const hasIssues = issues.length > 0;

    const messageRows = conv.messages.map(msg => {
      const isUser = msg.role === 'user';
      const bgColor = isUser ? '#0f0f1a' : '#1a1a2e';
      const roleLabel = isUser ? '👤 Student' : '🤖 Mentor';
      const content = (msg.content || '').slice(0, 400) + ((msg.content || '').length > 400 ? '...' : '');

      const metaTags = [];
      if (msg.emotion && msg.emotion !== 'neutral') metaTags.push(`😐 ${msg.emotion}`);
      if (msg.subject) metaTags.push(`📚 ${msg.subject}`);
      if (msg.mode && msg.mode !== 'teaching') metaTags.push(`🎯 ${msg.mode}`);
      if (msg.rag_hit === true)  metaTags.push(`✅ RAG hit`);
      if (msg.rag_hit === false && msg.role === 'assistant') metaTags.push(`⚠️ No RAG`);

      return `
        <div style="background:${bgColor};border-radius:8px;padding:12px 16px;margin:6px 0">
          <div style="font-size:11px;color:#6c63ff;font-weight:600;margin-bottom:6px">${roleLabel}
            ${metaTags.length > 0 ? `<span style="color:#64748b;font-weight:400;margin-left:8px">${metaTags.join(' · ')}</span>` : ''}
          </div>
          <div style="font-size:13px;color:#e2e8f0;line-height:1.6">${content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        </div>`;
    }).join('');

    const issueBlock = hasIssues ? `
      <div style="background:#1e1b2e;border-left:3px solid #f59e0b;border-radius:0 8px 8px 0;padding:12px 16px;margin:12px 0">
        <div style="font-size:12px;color:#f59e0b;font-weight:600;margin-bottom:8px">⚡ ISSUES DETECTED — ACTION NEEDED</div>
        ${issues.map(i => `
          <div style="margin:4px 0;font-size:13px;color:#e2e8f0">
            <strong>${i.type}</strong><br>
            <span style="color:#94a3b8">${i.detail}</span>
          </div>`).join('')}
      </div>` : `
      <div style="background:#0d1f17;border-left:3px solid #22c55e;border-radius:0 8px 8px 0;padding:10px 16px;margin:12px 0">
        <div style="font-size:12px;color:#22c55e">✅ No issues detected in this conversation</div>
      </div>`;

    return `
      <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <span style="font-size:15px;font-weight:600;color:#e2e8f0">${conv.name}</span>
            <span style="font-size:12px;color:#64748b;margin-left:8px">${conv.messages.length} messages</span>
          </div>
          <span style="font-size:11px;color:${hasIssues ? '#f59e0b' : '#22c55e'};background:${hasIssues ? '#2d1f00' : '#0d1f17'};padding:4px 10px;border-radius:20px">
            ${hasIssues ? `${issues.length} issue(s)` : 'Clean'}
          </span>
        </div>
        ${issueBlock}
        <div style="margin-top:12px">
          <div style="font-size:11px;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Conversation</div>
          ${messageRows}
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
<div style="max-width:720px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#f59e0b,#ef4444);border-radius:16px;padding:32px;margin-bottom:24px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">🔬</div>
    <h1 style="margin:0;font-size:22px;color:#fff;font-weight:700">Prompt Analysis Report</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px">${dateLabel}</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.65);font-size:12px">Use this to improve prompts, RAG content, and AI behaviour</p>
  </div>

  <!-- Summary Stats -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:15px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">📊 Yesterday at a Glance</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
      ${[
        ['Conversations', stats.totalConversations],
        ['Total Messages', stats.totalMessages],
        ['With Issues', stats.conversationsWithIssues],
        ['No RAG Hits', stats.noRagCount]
      ].map(([label, value]) => `
        <div style="background:#0f0f1a;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f59e0b">${value}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px">${label}</div>
        </div>`).join('')}
    </div>
  </div>

  <!-- What to Fix -->
  <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-bottom:24px">
    <h2 style="margin:0 0 12px;font-size:15px;color:#f59e0b;text-transform:uppercase;letter-spacing:1px">🛠️ What to Fix in Prompts</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:2;color:#e2e8f0">
      ${stats.noRagCount > 0
        ? `<li>⚠️ <strong>${stats.noRagCount} responses</strong> had no RAG content — ingest more PDFs for these subjects</li>`
        : '<li>✅ RAG content found for all responses</li>'}
      ${stats.confusedCount > 0
        ? `<li>🔄 <strong>${stats.confusedCount} conversations</strong> had confused students — improve explanation prompts</li>`
        : ''}
      ${stats.negativeEmotionCount > 0
        ? `<li>😰 <strong>${stats.negativeEmotionCount} conversations</strong> had stressed/frustrated students — check emotional support prompts</li>`
        : ''}
      ${stats.conversationsWithIssues === 0
        ? '<li>✅ No major prompt issues detected yesterday</li>'
        : ''}
    </ul>
  </div>

  <!-- All Conversations -->
  <h2 style="margin:0 0 16px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">💬 All Conversations</h2>
  ${conversations.length > 0 ? conversationBlocks : '<div style="background:#1a1a2e;border-radius:12px;padding:24px;text-align:center;color:#64748b">No conversations yesterday</div>'}

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

  // Security check
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

    // Fetch messages and profiles in parallel
    const [messages, profiles] = await Promise.all([
      query('chat_messages', `?created_at=gte.${startUTC}&created_at=lte.${endUTC}&select=*&order=created_at.asc`),
      query('user_profiles', `?select=id,name`)
    ]);

    console.log('[PROMPT-REPORT] Messages:', messages.length);

    // Group into conversations
    const conversations = groupIntoConversations(messages, profiles);

    // Calculate stats
    const analyzed = conversations.map(c => ({
      ...c,
      issues: analyzeConversation(c.messages)
    }));

    const stats = {
      totalConversations:      conversations.length,
      totalMessages:           messages.length,
      conversationsWithIssues: analyzed.filter(c => c.issues.length > 0).length,
      noRagCount:              messages.filter(m => m.role === 'assistant' && m.rag_hit === false).length,
      confusedCount:           analyzed.filter(c => c.issues.some(i => i.type.includes('Confused'))).length,
      negativeEmotionCount:    analyzed.filter(c => c.issues.some(i => i.type.includes('Emotion'))).length
    };

    // Build and send email
    const html = buildEmailHTML(conversations, dateLabel, stats);

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
        from:    FROM_EMAIL || 'MentorAI Reports <reports@acadoreskillsconsulting.com>',
        to:      TO_EMAILS,
        subject: `🔬 Prompt Analysis Report — ${dateLabel}`,
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
      stats
    });

  } catch (err) {
    console.error('[PROMPT-REPORT] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
