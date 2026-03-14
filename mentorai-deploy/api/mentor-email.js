// ============================================================
// api/mentor-email.js — MentorAI Proactive Email System
// ============================================================
// Generates personalised emails using AI and sends via Resend
// Called by: chat.js (on goal/schedule creation)
//            schedule-emails.js (daily cron)
// ============================================================

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const FROM_EMAIL    = process.env.MENTOR_EMAIL_FROM || 'MentorAI <mentor@acadoreskillsconsulting.com>';

// ── Supabase helper ──────────────────────────────────────────
async function supabase(table, method = 'GET', params = '', body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  return res.json().catch(() => ({}));
}

// ── Generate email content using AI ─────────────────────────
async function generateEmailContent(type, context) {
  const prompts = {

    roadmap: `You are MentorAI — a world-class personal mentor.
Generate a personalised learning roadmap email for ${context.name}.

Their goal: ${context.goal}
Their topic: ${context.topic}
Timeline: ${context.timeline_days} days
Learning style: ${context.learning_style || 'visual'}
Current level: ${context.current_level || 'beginner'}
Personality: ${context.personality || 'The Grower'}

Write a warm, motivating email with:
1. Personal greeting acknowledging their specific goal
2. A clear week-by-week roadmap broken into phases
3. What Day 1 looks like (specific, not generic)
4. One powerful story of someone who achieved a similar goal
5. Closing that makes them excited to start tomorrow

Format with clear sections. Use their name naturally. Maximum 400 words.
Return ONLY the email body HTML (no subject line).`,

    daily_concept: `You are MentorAI — a world-class personal mentor.
Generate Day ${context.current_day} learning email for ${context.name}.

Their goal: ${context.goal}
Their topic: ${context.topic}  
Day: ${context.current_day} of ${context.timeline_days}
Learning style: ${context.learning_style || 'visual'}
Personality: ${context.personality || 'The Grower'}
Previous topics covered: ${context.previous_topics || 'Starting fresh'}

Write a focused daily learning email with:
1. Quick personal check-in (1 sentence referencing their journey so far)
2. Today's concept — explained in their learning style (visual/story/logical/hands-on)
3. One real-world example or case study
4. One practice question to attempt before tomorrow
5. Motivating close — specific to where they are in their journey

Maximum 300 words. Warm, direct, never generic.
Return ONLY the email body HTML (no subject line).`,

    glossary: `You are MentorAI — a world-class personal mentor.
Generate a personalised glossary/definitions email for ${context.name}.

Their goal: ${context.goal}
Their topic: ${context.topic}
Interview/exam in: ${context.days_until} days
Learning style: ${context.learning_style || 'visual'}

Create a focused glossary email with:
1. Brief personal opening — acknowledge the timeline, keep calm energy
2. Top 15 most important terms/definitions for ${context.topic}
   - Each definition: term in bold, one-line explanation in plain English, one real example
3. A memory tip for the 3 hardest ones
4. Quick study instruction: how to use this glossary tonight

Format clearly. Easy to scan. Maximum 500 words.
Return ONLY the email body HTML (no subject line).`,

    mock_feedback: `You are MentorAI — a world-class personal mentor.
Generate a detailed mock interview feedback email for ${context.name}.

Topic: ${context.topic}
Questions asked: ${context.questions_asked}
User's answers: ${context.user_answers}
Strong points observed: ${context.strengths || 'To be identified'}
Areas to improve: ${context.improvements || 'To be identified'}

Write a constructive feedback email with:
1. What they did well — specific, named examples from their answers
2. 3 specific areas to improve — with exact suggestions for each
3. Rewrite one of their weak answers to show the ideal version
4. One focused exercise for tomorrow based on their biggest gap
5. Encouraging close — specific to their progress

Never shame. Wrong answers are data. Lead with strengths always.
Maximum 400 words.
Return ONLY the email body HTML (no subject line).`,

    missed_day: `You are MentorAI — a world-class personal mentor.
Generate a gentle re-engagement email for ${context.name}.

Their goal: ${context.goal}
Days since last session: ${context.days_missed}
Current day in their plan: ${context.current_day} of ${context.timeline_days}

Write a brief, warm re-engagement email:
1. No guilt. No pressure. Just genuine care.
2. Acknowledge that life gets busy — one sentence, warmly
3. Remind them what's waiting (today's topic — make it sound interesting)
4. One tiny action they can take right now (2 minutes max)
5. "See you when you're ready" energy

Maximum 150 words. Short. Human. Warm.
Return ONLY the email body HTML (no subject line).`,

    weekly_progress: `You are MentorAI — a world-class personal mentor.
Generate a weekly progress report email for ${context.name}.

Their goal: ${context.goal}
Week number: ${context.week_number}
Days completed this week: ${context.days_completed}
Topics covered: ${context.topics_covered}
Days until goal deadline: ${context.days_remaining}

Write a motivating weekly progress email with:
1. What they accomplished this week — specific topics named
2. One insight about their learning pattern you've noticed
3. What's coming next week — make it sound exciting
4. Their progress percentage toward the goal
5. One specific thing to do this weekend to stay sharp

Maximum 300 words. Celebratory but honest.
Return ONLY the email body HTML (no subject line).`
  };

  const prompt = prompts[type];
  if (!prompt) throw new Error(`Unknown email type: ${type}`);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

// ── Build full HTML email ────────────────────────────────────
function wrapEmailHTML(subject, bodyHTML, userName) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
<div style="max-width:600px;margin:0 auto;padding:24px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#e8c87a,#5ba4cf);border-radius:16px;padding:24px;margin-bottom:24px;text-align:center">
    <div style="font-size:28px;margin-bottom:6px">🎓</div>
    <h1 style="margin:0;font-size:20px;color:#080a0f;font-weight:700">MentorAI</h1>
    <p style="margin:4px 0 0;color:rgba(8,10,15,0.7);font-size:13px">Your Personal Learning Companion</p>
  </div>

  <!-- Body -->
  <div style="background:#1a1a2e;border-radius:12px;padding:28px;margin-bottom:20px;font-size:15px;line-height:1.8;color:#e2e8f0">
    ${bodyHTML}
  </div>

  <!-- CTA -->
  <div style="text-align:center;margin-bottom:20px">
    <a href="https://mentor-ai-swart.vercel.app" style="display:inline-block;background:linear-gradient(135deg,#e8c87a,#d4a850);color:#080a0f;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:600;font-size:15px">
      Continue Learning with MentorAI →
    </a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;color:#475569;font-size:12px;padding:8px">
    MentorAI · Your AI Mentor · <a href="https://mentor-ai-swart.vercel.app" style="color:#64748b">mentor-ai-swart.vercel.app</a>
  </div>

</div>
</body>
</html>`;
}

// ── Subject line generator ───────────────────────────────────
function getSubjectLine(type, context) {
  const subjects = {
    roadmap:          `🗺️ Your personalised ${context.topic} roadmap is ready, ${context.name}`,
    daily_concept:    `📚 Day ${context.current_day}: Today's concept for your ${context.topic} journey`,
    glossary:         `📖 Your ${context.topic} glossary — study this tonight, ${context.name}`,
    mock_feedback:    `💬 Your mock interview feedback is here, ${context.name}`,
    missed_day:       `👋 Hey ${context.name} — your mentor is thinking about you`,
    weekly_progress:  `📊 Week ${context.week_number} progress: Here's how you're doing, ${context.name}`
  };
  return subjects[type] || `MentorAI — A message for ${context.name}`;
}

// ── Send email via Resend ─────────────────────────────────────
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RESEND_KEY}`
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Email failed: ${JSON.stringify(data)}`);
  return data;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { type, context, schedule_id } = req.body;

    if (!type || !context) {
      return res.status(400).json({ error: 'type and context required' });
    }

    console.log(`[MENTOR-EMAIL] Sending ${type} email to ${context.email} for ${context.name}`);

    // Generate AI content
    const bodyHTML  = await generateEmailContent(type, context);
    const subject   = getSubjectLine(type, context);
    const fullHTML  = wrapEmailHTML(subject, bodyHTML, context.name);

    // Send email
    await sendEmail(context.email, subject, fullHTML);

    // Update schedule if provided
    if (schedule_id && type === 'daily_concept') {
      await supabase('mentor_schedules', 'PATCH',
        `?id=eq.${schedule_id}`,
        {
          current_day:      (context.current_day || 1) + 1,
          last_email_sent:  new Date().toISOString()
        }
      );
    }

    console.log(`[MENTOR-EMAIL] ✅ Sent ${type} to ${context.email}`);
    return res.status(200).json({ success: true, type, to: context.email });

  } catch (err) {
    console.error('[MENTOR-EMAIL] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
