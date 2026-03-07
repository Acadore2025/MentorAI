// ============================================================
// api/rag.js — MentorAI Retrieval Layer
// Uses Pinecone Integrated Embeddings (llama-text-embed-v2)
// ============================================================

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {

    const {
      query,
      learning_style = "visual",
      subject_filter = null,
      content_type = null,
      topK = 5
    } = req.body;

    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
    const PINECONE_HOST = process.env.PINECONE_HOST;

    if (!PINECONE_API_KEY || !PINECONE_HOST) {
      return res.status(500).json({
        error: "Missing Pinecone environment variables"
      });
    }

    console.log("RAG QUERY:", query);

    // ============================================================
    // SEARCH PINECONE (Integrated Embeddings)
    // ============================================================

    const pineconeRes = await fetch(`${PINECONE_HOST}/records/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": PINECONE_API_KEY
      },
      body: JSON.stringify({
        namespace: "__default__",
        query: {
          inputs: { text: query },
          top_k: topK * 3
        },
        fields: [
          "text",
          "subject",
          "topic",
          "learning_style",
          "content_type",
          "level"
        ]
      })
    });

    const raw = await pineconeRes.text();

    if (!pineconeRes.ok) {
      console.error("Pinecone error:", raw);
      throw new Error("Pinecone search failed");
    }

    const data = JSON.parse(raw);

    const matches = data.result?.hits || [];

    console.log("PINECONE MATCHES:", matches.length);

    if (matches.length > 0) {
      console.log(
        "FIRST MATCH:",
        matches[0].fields?.text?.slice(0, 200)
      );
    }

    if (matches.length === 0) {
      return res.status(200).json({
        results: [],
        context: "",
        found: false
      });
    }

    // ============================================================
    // RANK RESULTS
    // ============================================================

    const ranked = rankResults(matches, learning_style, content_type);

    // ============================================================
    // BUILD CONTEXT FOR LLM
    // ============================================================

    const context = buildContext(ranked.slice(0, topK));

    return res.status(200).json({
      results: ranked.slice(0, topK).map(m => ({
        text: m.fields?.text || "",
        subject: m.fields?.subject || "",
        topic: m.fields?.topic || "",
        learning_style: m.fields?.learning_style || "",
        content_type: m.fields?.content_type || "",
        score: Math.round((m._score || 0) * 100) / 100
      })),
      context,
      found: true,
      total_matches: matches.length
    });

  } catch (err) {

    console.error("RAG ERROR:", err);

    return res.status(200).json({
      results: [],
      context: "",
      found: false,
      error: err.message
    });

  }
}


// ============================================================
// RANK RESULTS BASED ON STUDENT PROFILE
// ============================================================

function rankResults(matches, learning_style, content_type) {

  return matches
    .map(match => {

      const style = match.fields?.learning_style || "";
      const type = match.fields?.content_type || "";

      const baseScore = match._score || 0;

      let boost = 0;

      if (style === learning_style) boost += 0.5;

      if (content_type && type === content_type) boost += 0.3;

      if (!content_type && type === "teaching") boost += 0.2;

      return {
        ...match,
        rankedScore: baseScore * (1 + boost)
      };

    })
    .sort((a, b) => b.rankedScore - a.rankedScore);

}


// ============================================================
// BUILD CONTEXT FOR GPT PROMPT
// ============================================================

function buildContext(results) {

  if (!results.length) return "";

  let context = "KNOWLEDGE BASE RESULTS:\n\n";

  results.forEach((r, i) => {

    const text = r.fields?.text || "";

    context += `[${i + 1}] ${text}\n\n`;

  });

  return context;

}
