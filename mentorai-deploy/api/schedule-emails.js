// ============================================================
// api/schedule-emails.js — Daily Email Scheduler
// ============================================================
// Runs every day at 8:00 AM IST (2:30 AM UTC)
// Sends daily concept emails to all active schedules
// Also sends missed-day emails to users silent for 2-3 days
// ============================================================

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;
const BASE_URL      = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://mentor-ai-swart.vercel.app';

// ── Supabase helper ──────────────────────────────────────────
async function query(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json'
    }
  });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

// ── Call mentor-email API ─────────────────────────────────────
async function sendMentorEmail(type, context, scheduleId) {
  const res = await fetch(`${BASE_URL}/api/mentor-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, context, schedule_id: scheduleId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Email send failed');
  return data;
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
    console.log('[SCHEDULE-EMAILS] Running daily email scheduler');

    // Fetch all active schedules
    const schedules = await query('mentor_schedules',
      `?status=eq.active&select=*`
    );

    console.log(`[SCHEDULE-EMAILS] Found ${schedules.length} active schedules`);

    const results = { sent: 0, missed: 0, completed: 0, errors: 0 };
    const now = new Date();

    for (const schedule of schedules) {
      try {
        const lastSent   = schedule.last_email_sent ? new Date(schedule.last_email_sent) : null;
        const daysSince  = lastSent ? Math.floor((now - lastSent) / (1000 * 60 * 60 * 24)) : 999;
        const currentDay = schedule.current_day || 1;
        const totalDays  = schedule.timeline_days || 30;

        // Schedule completed
        if (currentDay > totalDays) {
          await fetch(`${SUPABASE_URL}/rest/v1/mentor_schedules?id=eq.${schedule.id}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'completed' })
          });
          results.completed++;
          continue;
        }

        // User missed 2-3 days → send gentle re-engagement
        if (daysSince >= 2 && daysSince <= 3) {
          await sendMentorEmail('missed_day', {
            name:         schedule.user_name || 'there',
            email:        schedule.email,
            goal:         schedule.goal,
            topic:        schedule.topic,
            days_missed:  daysSince,
            current_day:  currentDay,
            timeline_days: totalDays
          }, schedule.id);
          results.missed++;
          continue;
        }

        // User missed more than 4 days → pause, don't spam
        if (daysSince > 3) {
          console.log(`[SCHEDULE] Skipping ${schedule.email} — ${daysSince} days silent`);
          continue;
        }

        // Send today's daily concept email
        if (daysSince >= 1 || !lastSent) {
          // Build previous topics from roadmap
          const roadmap = schedule.roadmap || {};
          const previousTopics = roadmap.completed_topics
            ? roadmap.completed_topics.slice(-3).join(', ')
            : 'Starting fresh';

          await sendMentorEmail('daily_concept', {
            name:             schedule.user_name || 'there',
            email:            schedule.email,
            goal:             schedule.goal,
            topic:            schedule.topic,
            current_day:      currentDay,
            timeline_days:    totalDays,
            learning_style:   schedule.learning_style || 'visual',
            personality:      schedule.personality || 'The Grower',
            previous_topics:  previousTopics
          }, schedule.id);

          results.sent++;

          // Send weekly progress on day 7, 14, 21, 28
          if (currentDay > 1 && currentDay % 7 === 0) {
            await sendMentorEmail('weekly_progress', {
              name:            schedule.user_name || 'there',
              email:           schedule.email,
              goal:            schedule.goal,
              topic:           schedule.topic,
              week_number:     Math.floor(currentDay / 7),
              days_completed:  Math.min(currentDay, 7),
              topics_covered:  previousTopics,
              days_remaining:  totalDays - currentDay
            }, null);
          }
        }

      } catch (scheduleErr) {
        console.error(`[SCHEDULE] Error for ${schedule.email}:`, scheduleErr.message);
        results.errors++;
      }
    }

    console.log('[SCHEDULE-EMAILS] Done:', results);
    return res.status(200).json({ success: true, results, total: schedules.length });

  } catch (err) {
    console.error('[SCHEDULE-EMAILS] Fatal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
