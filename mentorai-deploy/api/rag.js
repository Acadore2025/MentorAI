export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {

    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query missing" });
    }

    console.log("RAG QUERY:", query);

    const host = process.env.PINECONE_HOST;
    const apiKey = process.env.PINECONE_API_KEY;

    if (!host || !apiKey) {
      console.error("Missing Pinecone environment variables");
      return res.status(500).json({ error: "Missing Pinecone config" });
    }

    console.log("PINECONE HOST:", host);

    // ===============================
    // PINECONE SEARCH
    // ===============================

 const response = await fetch(`${process.env.PINECONE_HOST}/records/search`, {
  method: "POST",
  headers: {
    "Api-Key": process.env.PINECONE_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    query: {
      inputs: { text: query },
      top_k: 5
    }
  })
});

const raw = await response.text();

console.log("STATUS:", response.status);
console.log("RAW RESPONSE:", raw);

let data;

try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("JSON PARSE FAILED");
  throw e;
}

const hits = data?.result?.hits || [];

    console.log("PINECONE MATCHES:", hits.length);

    // ===============================
    // BUILD CONTEXT
    // ===============================

    let context = "";

    hits.forEach((hit, index) => {

      const text = hit?.fields?.text || "";

      context += `[${index + 1}] ${text}\n\n`;

    });

    return res.status(200).json({
      success: true,
      matches: hits.length,
      context: context
    });

  } catch (error) {

    console.error("RAG ERROR:", error);

    return res.status(200).json({
      success: false,
      context: "",
      matches: 0
    });

  }

}
