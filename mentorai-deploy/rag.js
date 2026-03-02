// ============================================================
// api/rag.js — MentorAI Smart Knowledge Retrieval
// ============================================================
// Called by chat.js before every AI response
// Searches Pinecone using student's learning style + query
// Returns the RIGHT version of content for THIS student
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const {
      query,                          // student's message
      learning_style = 'visual',      // from student profile
      subject_filter = null,          // optional: filter by subject
      content_type = null,            // optional: 'teaching' | 'flashcards' | 'practice'
      topK = 5
    } = req.body;

    if (!query) return res.status(400).json({ error: 'query is required' });

    const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
    const PINECONE_HOST    = process.env.PINECONE_HOST;

    if (!PINECONE_API_KEY || !PINECONE_HOST) {
      return res.status(500).json({ error: 'Missing Pinecone env vars' });
    }

    // ── STEP 1: Build a smart search query ───────────────────────
    // Combine student query with their learning style for better results
    const enrichedQuery = buildSmartQuery(query, learning_style, subject_filter);

    // ── STEP 2: Search Pinecone using integrated embedding ────────
    const searchRes = await fetch(`${PINECONE_HOST}/records/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PINECONE_API_KEY
      },
      body: JSON.stringify({
        namespace: 'teaching-content',
        query: {
          inputs: { text: enrichedQuery },
          top_k: topK * 3   // fetch more, then filter by style
        },
        fields: ['text', 'subject', 'topic', 'learning_style', 'level', 'exam_relevance', 'content_type']
      })
    });

    const searchData = await searchRes.json();
    const matches = searchData.result?.hits || searchData.matches || [];

    if (matches.length === 0) {
      return res.status(200).json({
        results: [],
        context: '',
        query,
        learning_style,
        found: false
      });
    }

    // ── STEP 3: Smart filtering and ranking ───────────────────────
    const ranked = rankResults(matches, learning_style, content_type);

    // ── STEP 4: Build clean context for the AI ────────────────────
    const context = buildContext(ranked.slice(0, topK), learning_style);

    return res.status(200).json({
      results: ranked.slice(0, topK).map(m => ({
        text: m.fields?.text || m.metadata?.text || '',
        subject: m.fields?.subject || m.metadata?.subject || '',
        topic: m.fields?.topic || m.metadata?.topic || '',
        learning_style: m.fields?.learning_style || m.metadata?.learning_style || '',
        content_type: m.fields?.content_type || m.metadata?.content_type || '',
        score: Math.round((m._score || m.score || 0) * 100) / 100
      })),
      context,
      query,
      learning_style,
      found: true,
      total_matches: matches.length
    });

  } catch (err) {
    console.error('RAG error:', err);
    // Return empty gracefully — AI will respond without RAG context
    return res.status(200).json({
      results: [],
      context: '',
      found: false,
      error: err.message
    });
  }
}

// ─────────────────────────────────────────────────────────────
// BUILD SMART QUERY
// Enriches the student's query with their learning style
// so Pinecone returns the most relevant version
// ─────────────────────────────────────────────────────────────
function buildSmartQuery(query, learning_style, subject_filter) {
  const styleDescriptions = {
    visual:    'visual diagram chart draw picture see',
    hands_on:  'hands-on experiment try practical do activity',
    story:     'story narrative history explain like tell me',
    logical:   'logical proof mathematical derive formula step by step'
  };

  const styleWords = styleDescriptions[learning_style] || styleDescriptions.visual;
  const subjectPart = subject_filter ? `subject: ${subject_filter}` : '';

  return `${query} ${styleWords} ${subjectPart}`.trim();
}

// ─────────────────────────────────────────────────────────────
// RANK RESULTS
// Prioritizes results matching student's learning style
// ─────────────────────────────────────────────────────────────
function rankResults(matches, learning_style, content_type) {
  return matches
    .map(match => {
      const matchStyle = match.fields?.learning_style || match.metadata?.learning_style || '';
      const matchType  = match.fields?.content_type   || match.metadata?.content_type   || '';
      const baseScore  = match._score || match.score || 0;

      let boost = 0;

      // +50% boost if learning style matches student's style
      if (matchStyle === learning_style) boost += 0.5;

      // +30% boost if content type matches requested type
      if (content_type && matchType === content_type) boost += 0.3;

      // +20% boost for teaching content (main explanation) by default
      if (!content_type && matchType === 'teaching') boost += 0.2;

      return {
        ...match,
        rankedScore: baseScore * (1 + boost)
      };
    })
    .sort((a, b) => b.rankedScore - a.rankedScore);
}

// ─────────────────────────────────────────────────────────────
// BUILD CONTEXT
// Formats the retrieved content for injection into AI prompt
// ─────────────────────────────────────────────────────────────
function buildContext(results, learning_style) {
  if (results.length === 0) return '';

  const styleLabel = {
    visual:   'Visual (diagram-based) learner',
    hands_on: 'Hands-on (practical) learner',
    story:    'Story (narrative) learner',
    logical:  'Logical (proof-based) learner'
  }[learning_style] || 'Visual learner';

  const chunks = results.map((r, i) => {
    const text = r.fields?.text || r.metadata?.text || '';
    const topic = r.fields?.topic || r.metadata?.topic || '';
    const type = r.fields?.content_type || r.metadata?.content_type || '';
    return `[Knowledge ${i + 1}] ${topic} (${type})\n${text}`;
  }).join('\n\n---\n\n');

  return `STUDENT LEARNING STYLE: ${styleLabel}

RETRIEVED KNOWLEDGE (use this to teach — adapt to student's style):
${chunks}`;
}
