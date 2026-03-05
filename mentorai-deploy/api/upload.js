// ============================================================
// api/upload.js - MentorAI PDF Ingestion Pipeline
// ============================================================
// POST /api/upload
// Header: x-admin-secret: your ADMIN_SECRET
// Body: multipart form with PDF file + metadata
// ============================================================

export const config = { api: { bodyParser: false } };

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_HOST    = process.env.PINECONE_HOST;
const OPENAI_KEY       = process.env.OPENAI_API_KEY;
const ADMIN_SECRET     = process.env.ADMIN_SECRET;

//  PARSE MULTIPART FORM 
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) return reject(new Error('No boundary found'));

      const parts = {};
      const boundaryBuffer = Buffer.from('--' + boundary);
      let start = 0;

      while (start < body.length) {
        const boundaryPos = body.indexOf(boundaryBuffer, start);
        if (boundaryPos === -1) break;
        const headerStart = boundaryPos + boundaryBuffer.length + 2;
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
        if (headerEnd === -1) break;

        const headers = body.slice(headerStart, headerEnd).toString();
        const contentStart = headerEnd + 4;
        const nextBoundary = body.indexOf(boundaryBuffer, contentStart);
        const contentEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
        const content = body.slice(contentStart, contentEnd);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);

        if (nameMatch) {
          const name = nameMatch[1];
          if (filenameMatch) {
            parts[name] = { buffer: content, filename: filenameMatch[1] };
          } else {
            parts[name] = content.toString().trim();
          }
        }
        start = nextBoundary === -1 ? body.length : nextBoundary;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

//  EXTRACT TEXT FROM PDF 
// Text is now extracted client-side (browser) and sent as plain text
// This function just validates and returns the text
function extractTextFromPDF(text) {
  if (!text || text.length < 50) {
    throw new Error('Could not extract text from PDF');
  }
  return text;
}

//  SPLIT TEXT INTO CHUNKS 
function splitIntoChunks(text, subject, classLevel, chunkSize = 800) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 50);

  let currentChunk = '';
  let chunkIndex = 0;

  for (const para of paragraphs) {
    if ((currentChunk + para).length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        id: `ncert_${subject.toLowerCase().replace(/\s+/g, '_')}_class${classLevel}_${chunkIndex}`,
        text: currentChunk.trim(),
        subject: subject,
        topic: extractTopic(currentChunk),
        learning_style: 'all',
        level: `Class ${classLevel}`,
        exam_relevance: 'CBSE,NCERT',
        content_type: 'ncert_textbook'
      });
      chunkIndex++;
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  // Last chunk
  if (currentChunk.trim().length > 50) {
    chunks.push({
      id: `ncert_${subject.toLowerCase().replace(/\s+/g, '_')}_class${classLevel}_${chunkIndex}`,
      text: currentChunk.trim(),
      subject: subject,
      topic: extractTopic(currentChunk),
      learning_style: 'all',
      level: `Class ${classLevel}`,
      exam_relevance: 'CBSE,NCERT',
      content_type: 'ncert_textbook'
    });
  }

  return chunks;
}

//  EXTRACT TOPIC FROM CHUNK 
function extractTopic(text) {
  const lines = text.split('\n').filter(l => l.trim());
  // First line is usually the topic/heading
  return lines[0]?.substring(0, 80) || 'General';
}

//  UPSERT TO PINECONE 
async function upsertToPinecone(chunks) {
  const batchSize = 20;
  let total = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const records = batch.map(chunk => ({
      _id: chunk.id,
      chunk_text: chunk.text,
      subject: chunk.subject,
      topic: chunk.topic,
      learning_style: chunk.learning_style,
      level: chunk.level,
      exam_relevance: chunk.exam_relevance,
      content_type: chunk.content_type
    }));

    const res = await fetch(`${PINECONE_HOST}/records/upsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PINECONE_API_KEY
      },
      body: JSON.stringify({
        namespace: 'teaching-content',
        records
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Pinecone upsert failed: ${err}`);
    }

    total += batch.length;
    await new Promise(r => setTimeout(r, 300));
  }

  return total;
}

// MAIN HANDLER - accepts pre-extracted text from browser
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!PINECONE_API_KEY || !PINECONE_HOST) {
    return res.status(500).json({ error: 'Missing Pinecone environment variables' });
  }

  try {
    // Text is extracted in browser - server only chunks + ingests
    const { text, filename, subject, classLevel } = req.body;

    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'No text content received' });
    }

    console.log(`[UPLOAD] Processing: ${filename} | ${subject} | Class ${classLevel} | ${text.length} chars`);

    // Step 1: Split into chunks
    const chunks = splitIntoChunks(text, subject, classLevel || '10');
    console.log(`[UPLOAD] Created ${chunks.length} chunks`);

    // Step 2: Upsert to Pinecone
    const upserted = await upsertToPinecone(chunks);

    return res.status(200).json({
      success: true,
      filename,
      subject,
      classLevel,
      chunks: upserted,
      characters: text.length,
      message: `Successfully ingested ${upserted} chunks from ${filename}`
    });

  } catch (err) {
    console.error('[UPLOAD] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
