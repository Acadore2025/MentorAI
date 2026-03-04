// ============================================================
// api/memory.js - MentorAI Memory Engine
// ============================================================
// Handles:
// 1. GET  - Load memory for a user (called on session start)
// 2. POST - Save/update memory after conversation
// ============================================================

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;

//  SUPABASE HELPER 
async function supabase(method, table, body = null, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${table}: ${err}`);
  }
  return res.json().catch(() => ({}));
}

//  SUMMARISE CONVERSATION 
async function summariseConversation(messages, existingSummary = '') {
  if (!OPENAI_KEY) return existingSummary;

  const recentMessages = messages.slice(-20); // last 20 messages
  const conversation = recentMessages
    .map(m => `${m.role === 'user' ? 'Student' : 'Mentor'}: ${m.content}`)
    .join('\n');

  const prompt = `You are summarising a student-mentor conversation for memory storage.

${existingSummary ? `EXISTING MEMORY:\n${existingSummary}\n\n` : ''}

RECENT CONVERSATION:
${conversation}

Extract and update the following in JSON format (no markdown, just JSON):
{
  "goal": "student's main learning goal or exam target",
  "weak_areas": ["list of topics/subjects they struggle with"],
  "strong_areas": ["list of topics they understand well"],
  "last_topic": "the most recent topic discussed",
  "last_session_summary": "2-3 sentence summary of what was covered today",
  "study_pattern": "any patterns observed (e.g. prefers evenings, gets anxious before exams)",
  "pending_followup": "anything left incomplete or to continue next session",
  "total_sessions_context": "cumulative context about this student across all sessions"
}

Keep it concise. Merge with existing memory, don't replace it.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', // use mini for summarisation - cost efficient
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3
    })
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  try {
    // Strip any markdown if present
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return { last_session_summary: text };
  }
}

//  MAIN HANDLER 
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  try {
    const userId = req.method === 'GET'
      ? req.query?.user_id
      : req.body?.user_id;

    if (!userId) return res.status(400).json({ error: 'user_id required' });

    //  GET: Load memory 
    if (req.method === 'GET') {
      try {
        const data = await supabase(
          'GET', 'user_memory',
          null,
          `?user_id=eq.${userId}&select=*&limit=1`
        );

        const memory = Array.isArray(data) ? data[0] : data;

        if (!memory) {
          return res.status(200).json({ memory: null, hasMemory: false });
        }

        return res.status(200).json({
          hasMemory: true,
          memory: {
            goal:                  memory.goal || '',
            weak_areas:            memory.weak_areas || [],
            strong_areas:          memory.strong_areas || [],
            last_topic:            memory.last_topic || '',
            last_session_summary:  memory.last_session_summary || '',
            study_pattern:         memory.study_pattern || '',
            pending_followup:      memory.pending_followup || '',
            total_sessions_context: memory.total_sessions_context || '',
            updated_at:            memory.updated_at || ''
          }
        });
      } catch(e) {
        // Table might not exist yet - return empty
        console.warn('Memory load failed (table may not exist yet):', e.message);
        return res.status(200).json({ memory: null, hasMemory: false });
      }
    }

    //  POST: Save/update memory 
    if (req.method === 'POST') {
      const { messages = [], existingMemory = null } = req.body;

      if (!messages.length) {
        return res.status(200).json({ saved: false, reason: 'no messages' });
      }

      // Only summarise if conversation is meaningful (5+ exchanges)
      if (messages.length < 5) {
        return res.status(200).json({ saved: false, reason: 'too short' });
      }

      // Generate updated memory summary
      const summary = await summariseConversation(
        messages,
        existingMemory ? JSON.stringify(existingMemory) : ''
      );

      // Upsert into Supabase
      await supabase('POST', 'user_memory', {
        user_id:               userId,
        goal:                  summary.goal || '',
        weak_areas:            summary.weak_areas || [],
        strong_areas:          summary.strong_areas || [],
        last_topic:            summary.last_topic || '',
        last_session_summary:  summary.last_session_summary || '',
        study_pattern:         summary.study_pattern || '',
        pending_followup:      summary.pending_followup || '',
        total_sessions_context: summary.total_sessions_context || '',
        updated_at:            new Date().toISOString()
      });

      console.log('[MEMORY] Saved for user:', userId);
      return res.status(200).json({ saved: true, summary });
    }

  } catch(err) {
    console.error('Memory error:', err);
    return res.status(500).json({ error: err.message });
  }
}
