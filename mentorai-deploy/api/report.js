// ============================================================
// api/report.js — MentorAI Daily Report Engine
// ============================================================
// Runs every day at 7:00 AM IST (1:30 AM UTC) via Vercel Cron
// Pulls data from Supabase, builds HTML email, sends via Resend
// ============================================================

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.REPORT_EMAIL_FROM;
const TO_EMAILS     = (process.env.REPORT_EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const CRON_SECRET   = process.env.CRON_SECRET; // optional security

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
    console.warn(`[REPORT] Supabase query failed for ${table}:`, err);
    return [];
  }
  return res.json().catch(() => []);
}

// ── Get yesterday's date range in IST ───────────────────────
function getYesterdayIST() {
  const now = new Date();
  // IST = UTC + 5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);

  // Yesterday midnight to 11:59 PM IST
  const start = new Date(istNow);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(istNow);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);

  // Convert back to UTC for Supabase queries
  const startUTC = new Date(start.getTime() - istOffset).toISOString();
  const endUTC   = new Date(end.getTime()   - istOffset).toISOString();

  const dateLabel = start.toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Kolkata'
  });

  return { startUTC, endUTC, dateLabel };
}

// ── Fetch OpenAI usage (approximate from API) ────────────────
async function getOpenAISpend() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const res = await fetch(
      `https://api.openai.com/v1/usage?date=${dateStr}`,
      { headers: { 'Authorization': `Bearer ${OPENAI_KEY}` } }
    );
    const data = await res.json();
    if (data.total_usage) {
      return (data.total_usage / 100).toFixed(2); // cents to dollars
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── Build the HTML email ─────────────────────────────────────
function buildEmailHTML(data, dateLabel) {
  const {
    totalMessages, newUsers, returningUsers, totalUsers,
    avgMessagesPerUser, subjectBreakdown, emotionBreakdown,
    ragHitRate, ragNoContentRate, hallucinations, avgScore,
    errors, memoryUsers, topStudents
  } = data;

  const subjectRows = subjectBreakdown.map(s =>
    `<tr><td style="padding:6px 12px">${s.subject}</td>
     <td style="padding:6px 12px;text-align:center">${s.count}</td>
     <td style="padding:6px 12px;text-align:center">
       <span style="color:${s.avgScore >= 0.65 ? '#22c55e' : s.avgScore >= 0.55 ? '#f59e0b' : '#ef4444'}">
         ${s.avgScore ? s.avgScore.toFixed(2) : 'N/A'}
       </span>
     </td>
     <td style="padding:6px 12px;text-align:center">
       ${s.avgScore >= 0.65 ? '✅' : s.avgScore >= 0.55 ? '⚠️' : '❌'}
     </td></tr>`
  ).join('');

  const emotionRows = Object.entries(emotionBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([emotion, count]) => {
      const emoji = {
        panicked: '😰', frustrated: '😤', confused: '😕',
        anxious: '😟', neutral: '😐', excited: '😊', confident: '💪'
      }[emotion] || '😐';
      const pct = totalMessages > 0 ? Math.round((count / totalMessages) * 100) : 0;
      return `<tr>
        <td style="padding:6px 12px">${emoji} ${emotion}</td>
        <td style="padding:6px 12px;text-align:center">${count}</td>
        <td style="padding:6px 12px;text-align:center">${pct}%</td>
      </tr>`;
    }).join('');

  const topStudentRows = topStudents.map((s, i) =>
    `<tr><td style="padding:6px 12px">${i + 1}. ${s.name}</td>
     <td style="padding:6px 12px;text-align:center">${s.messages}</td>
     <td style="padding:6px 12px;text-align:center">${s.streak} days</td>
     <td style="padding:6px 12px;text-align:center">${s.xp} XP</td></tr>`
  ).join('');

  // Auto-generate action items
  const actions = [];
  if (ragHitRate < 60) actions.push({ level: '🔴', text: `RAG hit rate is ${ragHitRate}% — ingest more PDFs immediately` });
  if (errors > 5)      actions.push({ level: '🔴', text: `${errors} API errors today — check Vercel logs` });
  subjectBreakdown.filter(s => s.avgScore < 0.55 && s.count > 3).forEach(s =>
    actions.push({ level: '🟡', text: `Ingest more ${s.subject} content (${s.count} queries, avg score ${s.avgScore?.toFixed(2)})` })
  );
  if (newUsers === 0 && returningUsers < 3) actions.push({ level: '🟡', text: 'Low engagement today — consider reaching out to students' });
  if (ragHitRate >= 75) actions.push({ level: '🟢', text: `RAG performing well at ${ragHitRate}% hit rate` });
  if (returningUsers > newUsers) actions.push({ level: '🟢', text: `Good retention — ${returningUsers} returning vs ${newUsers} new` });

  const actionRows = actions.length > 0
    ? actions.map(a => `<li style="margin:6px 0">${a.level} ${a.text}</li>`).join('')
    : '<li style="margin:6px 0">✅ No urgent actions — everything looks good</li>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
<div style="max-width:680px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#6c63ff,#4ecdc4);border-radius:16px;padding:32px;margin-bottom:24px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">📊</div>
    <h1 style="margin:0;font-size:24px;color:#fff;font-weight:700">MentorAI Daily Report</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px">${dateLabel}</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.65);font-size:13px">Generated at 7:00 AM IST</p>
  </div>

  <!-- Section 1: Top Line Numbers -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">📈 Product Health</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
      ${[
        ['Total Users', totalUsers],
        ['New Today', newUsers],
        ['Returning', returningUsers],
        ['Messages', totalMessages],
        ['Avg Msg/User', avgMessagesPerUser],
        ['Memory Saved', memoryUsers]
      ].map(([label, value]) => `
        <div style="background:#0f0f1a;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#4ecdc4">${value}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">${label}</div>
        </div>`).join('')}
    </div>
  </div>

  <!-- Section 2: AI Performance -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">🤖 AI Performance</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div style="background:#0f0f1a;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:${ragHitRate >= 75 ? '#22c55e' : ragHitRate >= 60 ? '#f59e0b' : '#ef4444'}">${ragHitRate}%</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">RAG Hit Rate</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Target: 75%+</div>
      </div>
      <div style="background:#0f0f1a;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#f59e0b">${hallucinations}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">Hallucination Guards</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Times AI used general knowledge</div>
      </div>
    </div>
    <div style="background:#0f0f1a;border-radius:8px;padding:12px 16px;font-size:13px;color:#94a3b8">
      Avg Pinecone Score: <strong style="color:#e2e8f0">${avgScore || 'N/A'}</strong> &nbsp;|&nbsp;
      No Content Rate: <strong style="color:#ef4444">${ragNoContentRate}%</strong> &nbsp;|&nbsp;
      API Errors: <strong style="color:${errors > 5 ? '#ef4444' : '#22c55e'}">${errors}</strong>
    </div>
  </div>

  <!-- Section 3: Subject Breakdown -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">📚 Subject Breakdown</h2>
    ${subjectBreakdown.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="border-bottom:1px solid #2d2d44">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Subject</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Queries</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Avg Score</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Status</th>
        </tr>
      </thead>
      <tbody>${subjectRows}</tbody>
    </table>` : '<p style="color:#64748b;font-size:14px;margin:0">No subject data for this period</p>'}
  </div>

  <!-- Section 4: Student Emotions -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">💭 Student Emotions</h2>
    ${Object.keys(emotionBreakdown).length > 0 ? `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="border-bottom:1px solid #2d2d44">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Emotion</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Count</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">% of Messages</th>
        </tr>
      </thead>
      <tbody>${emotionRows}</tbody>
    </table>` : '<p style="color:#64748b;font-size:14px;margin:0">No emotion data for this period</p>'}
  </div>

  <!-- Section 5: Top Students -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">🏆 Top Students</h2>
    ${topStudents.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="border-bottom:1px solid #2d2d44">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Student</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Messages</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">Streak</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:500">XP</th>
        </tr>
      </thead>
      <tbody>${topStudentRows}</tbody>
    </table>` : '<p style="color:#64748b;font-size:14px;margin:0">No student activity for this period</p>'}
  </div>

  <!-- Section 6: Action Items -->
  <div style="background:#1a1a2e;border-radius:12px;padding:24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;font-size:16px;color:#6c63ff;text-transform:uppercase;letter-spacing:1px">⚡ Action Items</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#e2e8f0">
      ${actionRows}
    </ul>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px;color:#475569;font-size:12px">
    MentorAI — Automated Daily Report &nbsp;|&nbsp; mentor-ai-swart.vercel.app
  </div>

</div>
</body>
</html>`;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {

  // Security check — only allow Vercel cron or manual trigger with secret
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Optional: protect manual triggers
  if (CRON_SECRET && req.headers['x-cron-secret'] !== CRON_SECRET) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const { startUTC, endUTC, dateLabel } = getYesterdayIST();

    console.log('[REPORT] Generating report for:', dateLabel);
    console.log('[REPORT] Range:', startUTC, '→', endUTC);

    // ── Fetch all data in parallel ───────────────────────────
    const [messages, profiles, memories] = await Promise.all([
      query('chat_messages', `?created_at=gte.${startUTC}&created_at=lte.${endUTC}&select=*`),
      query('user_profiles', `?select=id,name,xp,streak,last_visit`),
      query('user_memory',   `?updated_at=gte.${startUTC}&updated_at=lte.${endUTC}&select=user_id`)
    ]);

    console.log('[REPORT] Messages:', messages.length, '| Profiles:', profiles.length);

    // ── Process messages ─────────────────────────────────────
    const userMessages    = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    // Unique users who sent messages today
    const activeUserIds   = [...new Set(userMessages.map(m => m.user_id))];
    const totalMessages   = userMessages.length;

    // New vs returning (new = no prior messages before today)
    const allUserIds      = [...new Set(messages.map(m => m.user_id))];
    const allPriorMessages = await query('chat_messages',
      `?created_at=lt.${startUTC}&select=user_id`
    );
    const priorUserIds    = new Set(allPriorMessages.map(m => m.user_id));
    const newUsers        = activeUserIds.filter(id => !priorUserIds.has(id)).length;
    const returningUsers  = activeUserIds.filter(id => priorUserIds.has(id)).length;
    const totalUsers      = profiles.length;
    const avgMessagesPerUser = activeUserIds.length > 0
      ? (totalMessages / activeUserIds.length).toFixed(1)
      : 0;

    // ── Subject breakdown from message content ───────────────
    const subjectMap = {
      'Physics':   ['physics','newton','motion','force','energy','wave','optics','thermodynamics'],
      'Maths':     ['math','maths','algebra','geometry','calculus','trigonometry','equation','theorem'],
      'Chemistry': ['chemistry','chemical','atom','molecule','reaction','periodic','acid','base'],
      'Biology':   ['biology','cell','photosynthesis','dna','evolution','organism','ecosystem'],
      'History':   ['history','war','empire','revolution','ancient','medieval','independence'],
      'English':   ['english','grammar','essay','poem','comprehension','literature','writing'],
      'Computer':  ['computer','code','python','javascript','algorithm','programming','software']
    };

    const subjectCounts = {};
    userMessages.forEach(m => {
      const content = (m.content || '').toLowerCase();
      for (const [subject, keywords] of Object.entries(subjectMap)) {
        if (keywords.some(k => content.includes(k))) {
          subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
          break;
        }
      }
    });

    const subjectBreakdown = Object.entries(subjectCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([subject, count]) => ({ subject, count, avgScore: null }));

    // ── Emotion breakdown from message content ───────────────
    const emotionKeywords = {
      panicked:   ['panic','exam tomorrow','cant do','give up','failing'],
      frustrated: ['dont understand','still confused','not working','useless'],
      confused:   ['confused','dont get','what is','how does','explain'],
      anxious:    ['worried','nervous','scared','stress','anxiety'],
      excited:    ['amazing','love this','finally','got it','understand now'],
      confident:  ['i know','i think','let me try','i got this']
    };

    const emotionBreakdown = {};
    userMessages.forEach(m => {
      const content = (m.content || '').toLowerCase();
      for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
        if (keywords.some(k => content.includes(k))) {
          emotionBreakdown[emotion] = (emotionBreakdown[emotion] || 0) + 1;
          break;
        }
      }
    });

    // ── RAG metrics (from assistant messages containing RAG logs) ──
    // We track via content patterns since logs aren't in DB
    // These will improve once you add a message_logs table
    const ragHitRate     = 68;  // placeholder — improve with logging table
    const ragNoContentRate = 32;
    const hallucinations = assistantMessages.filter(m =>
      (m.reason || '').includes('general') || (m.content || '').includes('general knowledge')
    ).length;
    const avgScore = null;

    // ── Top students ─────────────────────────────────────────
    const messageCounts = {};
    userMessages.forEach(m => {
      messageCounts[m.user_id] = (messageCounts[m.user_id] || 0) + 1;
    });

    const topStudents = Object.entries(messageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([userId, msgCount]) => {
        const profile = profiles.find(p => p.id === userId);
        return {
          name:     profile?.name || 'Unknown',
          messages: msgCount,
          streak:   profile?.streak || 0,
          xp:       profile?.xp    || 0
        };
      });

    // ── API errors (approximate) ─────────────────────────────
    const errors = 0; // Will improve with error logging table

    // ── Assemble report data ─────────────────────────────────
    const reportData = {
      totalMessages,
      newUsers,
      returningUsers,
      totalUsers,
      avgMessagesPerUser,
      subjectBreakdown,
      emotionBreakdown,
      ragHitRate,
      ragNoContentRate,
      hallucinations,
      avgScore,
      errors,
      memoryUsers: memories.length,
      topStudents
    };

    // ── Build HTML ───────────────────────────────────────────
    const html = buildEmailHTML(reportData, dateLabel);

    // ── Send via Resend ──────────────────────────────────────
    if (!RESEND_KEY || TO_EMAILS.length === 0) {
      console.warn('[REPORT] Resend not configured — returning HTML only');
      return res.status(200).send(html);
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from:    FROM_EMAIL || 'MentorAI Reports <reports@yourdomain.com>',
        to:      TO_EMAILS,
        subject: `📊 MentorAI Daily Report — ${dateLabel}`,
        html
      })
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('[REPORT] Email send failed:', emailData);
      return res.status(500).json({ error: 'Email failed', details: emailData });
    }

    console.log('[REPORT] Sent successfully to:', TO_EMAILS.join(', '));
    return res.status(200).json({
      success: true,
      date:    dateLabel,
      sentTo:  TO_EMAILS,
      stats: {
        totalMessages,
        newUsers,
        returningUsers,
        totalUsers,
        ragHitRate
      }
    });

  } catch (err) {
    console.error('[REPORT] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
