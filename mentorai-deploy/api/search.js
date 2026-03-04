// ============================================================
// api/search.js — MentorAI Web Search via Tavily
// ============================================================
// Called automatically when student asks about:
// - Current affairs, news, recent events
// - Exam notifications, dates, results
// - Anything not in the Pinecone knowledge base
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { query, search_depth = 'basic', max_results = 5 } = req.body;

    if (!query) return res.status(400).json({ error: 'query is required' });

    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    if (!TAVILY_API_KEY) return res.status(500).json({ error: 'TAVILY_API_KEY not configured' });

    // ── Call Tavily Search API ────────────────────────────────
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth,          // 'basic' (fast) or 'advanced' (deeper)
        max_results,
        include_answer: true,  // Tavily gives a direct answer summary
        include_raw_content: false
      })
    });

    const data = await tavilyRes.json();

    if (!tavilyRes.ok) {
      throw new Error(data.message || data.error || 'Tavily search failed');
    }

    // ── Format results cleanly for the AI ────────────────────
    const results = (data.results || []).map(r => ({
      title:   r.title   || '',
      url:     r.url     || '',
      content: r.content || '',
      score:   r.score   || 0
    }));

    // Build clean context string for AI prompt injection
    const context = buildSearchContext(query, data.answer, results);

    return res.status(200).json({
      success: true,
      query,
      answer:  data.answer  || '',   // Tavily's direct answer
      results,
      context,                        // Formatted for AI prompt
      total: results.length
    });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// BUILD SEARCH CONTEXT
// Formats Tavily results for clean injection into AI prompt
// ─────────────────────────────────────────────────────────────
function buildSearchContext(query, answer, results) {
  if (results.length === 0) return '';

  let context = `WEB SEARCH RESULTS for: "${query}"\n\n`;

  // Tavily's direct answer summary (most useful)
  if (answer) {
    context += `DIRECT ANSWER:\n${answer}\n\n`;
  }

  // Top sources
  context += `SOURCES:\n`;
  results.slice(0, 3).forEach((r, i) => {
    context += `[${i + 1}] ${r.title}\n${r.content.slice(0, 300)}...\nSource: ${r.url}\n\n`;
  });

  return context;
}
