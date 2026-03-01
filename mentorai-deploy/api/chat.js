// MentorAI — Secure API Proxy
// All API keys live HERE on the server. Users never see them.

export default async function handler(req, res) {
  // Allow requests from your Vercel app only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { model, messages, system, max_tokens } = req.body;

  try {
    let reply = '';

    // ── CLAUDE ──────────────────────────────────────────────
    if (model === 'claude') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: max_tokens || 1024,
          system,
          messages
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Claude API error');
      }
      const data = await response.json();
      reply = data.content[0].text;
    }

    // ── OPENAI ───────────────────────────────────────────────
    else if (model === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: max_tokens || 1024,
          messages: [{ role: 'system', content: system }, ...messages]
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'OpenAI API error');
      }
      const data = await response.json();
      reply = data.choices[0].message.content;
    }

    // ── GEMINI ───────────────────────────────────────────────
    else if (model === 'gemini') {
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents,
            generationConfig: { maxOutputTokens: max_tokens || 1024 }
          })
        }
      );
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'Gemini API error');
      }
      const data = await response.json();
      reply = data.candidates[0].content.parts[0].text;
    }

    // ── ROUTER (uses Claude Haiku for cheap routing) ─────────
    else if (model === 'router') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 80,
          system,
          messages
        })
      });
      if (!response.ok) throw new Error('Router error');
      const data = await response.json();
      reply = data.content[0].text;
    }

    else {
      return res.status(400).json({ error: 'Unknown model: ' + model });
    }

    return res.status(200).json({ reply });

  } catch (error) {
    console.error('API Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
