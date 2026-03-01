// MentorAI — Secure API Proxy
// All API keys live HERE on the server. Users never see them.


// Keyword-based fallback router
function smartRoute(msg) {
  const l = msg.toLowerCase();
  // Only route to models that actually have keys configured
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  if (hasGemini && (l.includes('trend') || l.includes('market') || l.includes('latest') || l.includes('news')))
    return JSON.stringify({model:'gemini', reason:'Trend query'});
  if (hasClaude && (l.includes('career') || l.includes('goal') || l.includes('life') || l.includes('feeling') || l.includes('emotion')))
    return JSON.stringify({model:'claude', reason:'Career/life query'});
  // Default to first available key
  if (hasOpenAI) return JSON.stringify({model:'openai', reason:'Auto-selected'});
  if (hasClaude) return JSON.stringify({model:'claude', reason:'Auto-selected'});
  if (hasGemini) return JSON.stringify({model:'gemini', reason:'Auto-selected'});
  return JSON.stringify({model:'openai', reason:'Default'});
}

export default async function handler(req, res) {
  // Allow requests from your Vercel app only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { messages, system, max_tokens } = body;
  
  // Smart fallback — if requested model has no key, fall back to openai
  let model = body.model || 'openai';
  if (model === 'claude' && !process.env.ANTHROPIC_API_KEY) model = 'openai';
  if (model === 'gemini' && !process.env.GEMINI_API_KEY) model = 'openai';
  if (!model || model === 'route') {
    // Auto-select based on available keys
    if (process.env.OPENAI_API_KEY) model = 'openai';
    else if (process.env.ANTHROPIC_API_KEY) model = 'claude';
    else if (process.env.GEMINI_API_KEY) model = 'gemini';
    else model = 'openai';
  }

  try {
    let reply = '';

    // ── CLAUDE ──────────────────────────────────────────────
    if (model === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Claude API key not configured on server. Please add ANTHROPIC_API_KEY in Vercel settings.' });
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
      if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI API key not configured on server. Please add OPENAI_API_KEY in Vercel settings.' });
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
      if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'Gemini API key not configured on server. Please add GEMINI_API_KEY in Vercel settings.' });
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

    // ── ROUTER — uses best available key ─────────────────────
    else if (model === 'router') {
      const userMsg = messages[0]?.content || '';
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST',
            headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
            body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:80,system,messages})
          });
          if(r.ok){ const d=await r.json(); reply=d.content[0].text; }
          else reply = smartRoute(userMsg);
        } catch(e){ reply = smartRoute(userMsg); }
      } else if (process.env.OPENAI_API_KEY) {
        try {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},
            body:JSON.stringify({model:'gpt-4o-mini',max_tokens:80,messages:[{role:'system',content:system},...messages]})
          });
          if(r.ok){ const d=await r.json(); reply=d.choices[0].message.content; }
          else reply = smartRoute(userMsg);
        } catch(e){ reply = smartRoute(userMsg); }
      } else {
        reply = smartRoute(userMsg);
      }
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
