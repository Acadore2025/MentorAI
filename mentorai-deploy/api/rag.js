// ============================================================
// api/rag.js — MentorAI Production RAG Engine
// ============================================================
// Improvements over v1:
// 1. Score threshold filtering  — stops low-quality chunks reaching AI
// 2. Query rewriting             — cleans vague/follow-up queries before search
// 3. Dynamic top_k               — based on intent mode (panic=2, deep=8)
// 4. Context window budget       — hard cap prevents prompt overflow
// 5. Retry logic                 — one retry on Pinecone timeout
// 6. Proper error status codes   — 503 on infra failure vs 200 empty
// 7. Hallucination signal        — noRelevantContent flag for chat.js
// 8. Structured logging          — hit count + top score on every request
// ============================================================

const MIN_SCORE      = 0.72;   // Chunks below this are noise — tune if needed
const MAX_CONTEXT_CHARS = 3000; // ~750 tokens — safe budget inside 1200 max_tokens
const RETRY_DELAY_MS = 500;    // Wait before single retry on timeout

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { query, mode, subject, recentHistory = [] } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query missing' });
    }

    const host   = process.env.PINECONE_HOST;
    const apiKey = process.env.PINECONE_API_KEY;

    if (!host || !apiKey) {
      console.error('[RAG] Missing Pinecone environment variables');
      return res.status(500).json({ error: 'Missing Pinecone config' });
    }

    // ─────────────────────────────────────────────────────────
    // STEP 1: Query Rewriting
    // Vague follow-ups like "explain it again" or "i don't get it"
    // produce garbage embeddings. Rewrite to extract real intent.
    // ─────────────────────────────────────────────────────────
    const cleanQuery = await rewriteQuery(query, recentHistory);
    console.log(`[RAG] Original: "${query}" → Rewritten: "${cleanQuery}"`);

    // ─────────────────────────────────────────────────────────
    // STEP 2: Dynamic top_k based on mode
    // Panicked student → 2 chunks (less overwhelm)
    // Deep teaching    → 8 chunks (more context)
    // Default          → 5 chunks
    // ─────────────────────────────────────────────────────────
    const topK = getTopK(mode);

    // ─────────────────────────────────────────────────────────
    // STEP 3: Pinecone Search with retry
    // ─────────────────────────────────────────────────────────
    let data = await pineconeSearch(host, apiKey, cleanQuery, topK, subject);

    // Single retry on failure
    if (!data) {
      console.warn('[RAG] Retrying Pinecone after', RETRY_DELAY_MS, 'ms...');
      await sleep(RETRY_DELAY_MS);
      data = await pineconeSearch(host, apiKey, cleanQuery, topK, subject);
    }

    if (!data) {
      // Infra is down — return 503 so chat.js knows this is a real failure
      // not just "no results found"
      return res.status(503).json({
        success: false,
        context: '',
        matches: 0,
        error: 'Pinecone unavailable after retry'
      });
    }

    const allHits = data?.result?.hits || [];

    // ─────────────────────────────────────────────────────────
    // STEP 4: Score threshold filtering
    // Discard chunks below MIN_SCORE — they are noise
    // ─────────────────────────────────────────────────────────
    const hits = allHits.filter(hit => (hit._score || hit.score || 0) >= MIN_SCORE);

    const topScore   = allHits[0]?._score || allHits[0]?.score || 0;
    const passedCount = hits.length;

    console.log(`[RAG] Pinecone: ${allHits.length} raw hits | ${passedCount} passed threshold (${MIN_SCORE}) | top score: ${topScore.toFixed(3)}`);

    // ─────────────────────────────────────────────────────────
    // STEP 5: noRelevantContent signal
    // If nothing passes threshold, signal chat.js explicitly
    // so it uses general knowledge instead of hallucinating
    // ─────────────────────────────────────────────────────────
    if (hits.length === 0) {
      console.log('[RAG] No chunks passed score threshold — signalling noRelevantContent');
      return res.status(200).json({
        success: true,
        context: '',
        matches: 0,
        noRelevantContent: true,
        topScore
      });
    }

    // ─────────────────────────────────────────────────────────
    // STEP 6: Build context with hard character budget
    // Prevents silent prompt overflow / truncated AI responses
    // ─────────────────────────────────────────────────────────
    let context = '';
    let usedChunks = 0;

    for (let i = 0; i < hits.length; i++) {
      const text   = hits[i]?.fields?.text || '';
      const score  = (hits[i]._score || hits[i].score || 0).toFixed(3);
      const chunk  = `[${i + 1}] ${text}\n\n`;

      if ((context + chunk).length > MAX_CONTEXT_CHARS) {
        console.log(`[RAG] Context budget reached at chunk ${i + 1} — stopping`);
        break;
      }

      context += chunk;
      usedChunks++;
    }

    console.log(`[RAG] Context built: ${usedChunks} chunks, ${context.length} chars`);

    return res.status(200).json({
      success: true,
      matches: usedChunks,
      context,
      noRelevantContent: false,
      topScore,
      rewrittenQuery: cleanQuery
    });

  } catch (error) {
    console.error('[RAG] Unhandled error:', error);

    // Return 503 — actual infra/code failure, not "no results"
    // chat.js can distinguish and handle gracefully
    return res.status(503).json({
      success: false,
      context: '',
      matches: 0,
      error: error.message
    });
  }
}

// ─────────────────────────────────────────────────────────────
// QUERY REWRITER
// Uses GPT-4o-mini (cheap: ~$0.00015/call) to extract true search
// intent from vague or follow-up student messages.
// Falls back to original query if rewrite fails.
// ─────────────────────────────────────────────────────────────
async function rewriteQuery(query, recentHistory = []) {
  // Skip rewrite for clear, specific queries — saves cost
  const isAlreadyClear = query.length > 15 &&
    !/(it|this|that|again|re-?explain|don.?t get|what do you mean|huh|still|same thing)/i.test(query);

  if (isAlreadyClear) return query;

  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) return query; // Graceful fallback — never block the request

  try {
    const historySnippet = recentHistory
      .slice(-3)
      .map(m => `${m.role === 'user' ? 'Student' : 'Mentor'}: ${(m.content || '').slice(0, 150)}`)
      .join('\n');

    const prompt = `You are rewriting a student's vague message into a clean knowledge-base search query.

Recent conversation:
${historySnippet || '(no history)'}

Student's message: "${query}"

Write ONE short search query (5-12 words) that captures what concept they need explained.
Return ONLY the query. No punctuation, no explanation, no quotes.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${openAiKey}`
      },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  40,
        temperature: 0.1
      })
    });

    const data = await res.json();
    const rewritten = data?.choices?.[0]?.message?.content?.trim();

    return (rewritten && rewritten.length > 3) ? rewritten : query;

  } catch (err) {
    console.warn('[RAG] Query rewrite failed (non-critical):', err.message);
    return query; // Always fall back to original
  }
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC top_k
// Fewer chunks for panicked/tired students (less overwhelm)
// More chunks for deep teaching/comparison modes
// ─────────────────────────────────────────────────────────────
function getTopK(mode) {
  const topKMap = {
    exam_panic:       2,  // Quick hits only — student is stressed
    tired:            2,  // Short session
    flashcards:       3,  // Card-sized facts
    summary:          4,  // Overview needs some breadth
    comparison:       8,  // Needs both concepts in context
    teaching:         5,  // Standard
    practice:         5,  // Standard
    study_plan:       6,  // Needs full topic coverage
  };
  return topKMap[mode] || 5;
}

// ─────────────────────────────────────────────────────────────
// PINECONE SEARCH
// Isolated so it can be retried cleanly
// ─────────────────────────────────────────────────────────────
async function pineconeSearch(host, apiKey, query, topK, subject) {
  try {
    // Build filter if subject is known — narrows search to relevant chunks
    // Requires subject metadata stored at ingest time
    const filter = subject ? { subject: { '$eq': subject } } : undefined;

    const body = {
      query: {
        inputs: { text: query },
        top_k: topK,
        ...(filter && { filter })
      }
    };

    const response = await fetch(`${host}/records/search`, {
      method:  'POST',
      headers: {
        'Api-Key':      apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[RAG] Pinecone HTTP ${response.status}:`, errText);
      return null;
    }

    const raw = await response.text();

    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('[RAG] JSON parse failed on Pinecone response');
      return null;
    }

  } catch (err) {
    console.error('[RAG] Pinecone fetch error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
