// ============================================================
// api/rag.js — MentorAI Vector Retrieval (OpenAI + Pinecone)
// ============================================================
// Flow
// 1. Embed the student query using OpenAI
// 2. Search Pinecone vector index
// 3. Return top chunks
// 4. Build clean context for GPT
// ============================================================

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {

    const {
      query,
      learning_style = 'visual',
      subject_filter = null,
      content_type = null,
      topK = 5
    } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
    const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
    const PINECONE_HOST    = process.env.PINECONE_HOST;

    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST) {
      return res.status(500).json({ error: 'Missing environment variables' });
    }

    // --------------------------------------------------------
    // STEP 1 — Embed query using OpenAI
    // --------------------------------------------------------

    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: query,
        dimensions: 1024
      })
    });

    const embedData = await embedRes.json();

    const vector = embedData.data?.[0]?.embedding;

    if (!vector) {
      throw new Error("Failed to create embedding");
    }

    // --------------------------------------------------------
    // STEP 2 — Search Pinecone
    // --------------------------------------------------------

    const pineconeRes = await fetch(`${PINECONE_HOST}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": PINECONE_API_KEY
      },
      body: JSON.stringify({
        vector: vector,
        topK: topK * 3,
        includeMetadata: true,
        namespace: "teaching-content"
      })
    });

    const pineconeData = await pineconeRes.json();

    const matches = pineconeData.matches || [];

    if (matches.length === 0) {
      return res.status(200).json({
        results: [],
        context: "",
        query,
        learning_style,
        found: false
      });
    }

    // --------------------------------------------------------
    // STEP 3 — Rank results
    // --------------------------------------------------------

    const ranked = rankResults(matches, learning_style, content_type);

    // --------------------------------------------------------
    // STEP 4 — Build AI context
    // --------------------------------------------------------

    const context = buildContext(ranked.slice(0, topK));

    return res.status(200).json({
      results: ranked.slice(0, topK).map(m => ({
        text: m.metadata?.text || "",
        subject: m.metadata?.subject || "",
        topic: m.metadata?.topic || "",
        learning_style: m.metadata?.learning_style || "",
        content_type: m.metadata?.content_type || "",
        score: Math.round((m.score || 0) * 100) / 100
      })),
      context,
      query,
      learning_style,
      found: true,
      total_matches: matches.length
    });

  } catch (err) {

    console.error("RAG error:", err);

    return res.status(200).json({
      results: [],
      context: "",
      found: false,
      error: err.message
    });

  }
}


// ============================================================
// RANK RESULTS
// ============================================================

function rankResults(matches, learning_style, content_type) {

  return matches
    .map(match => {

      const matchStyle = match.metadata?.learning_style || "";
      const matchType  = match.metadata?.content_type || "";

      let score = match.score || 0;
      let boost = 0;

      if (matchStyle === learning_style) boost += 0.5;

      if (content_type && matchType === content_type) boost += 0.3;

      if (!content_type && matchType === "teaching") boost += 0.2;

      return {
        ...match,
        rankedScore: score * (1 + boost)
      };

    })
    .sort((a, b) => b.rankedScore - a.rankedScore);

}


// ============================================================
// BUILD CONTEXT FOR GPT
// ============================================================

function buildContext(results) {

  if (!results.length) return "";

  let context = "KNOWLEDGE BASE RESULTS:\n\n";

  results.forEach((r, i) => {

    const text = r.metadata?.text || "";

    context += `[${i + 1}] ${text}\n\n`;

  });

  return context;
}
