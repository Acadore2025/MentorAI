// api/upload.js - MentorAI PDF Ingestion
// Receives pre-extracted text from browser, chunks it, upserts to Pinecone

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_HOST    = process.env.PINECONE_HOST;
const ADMIN_SECRET     = process.env.ADMIN_SECRET;

function splitIntoChunks(text, subject, classLevel) {
  const chunks = [];
  const chunkSize = 800;
  const baseId = 'ncert_' + subject.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_c' + classLevel + '_' + Date.now();
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  let current = '';
  let idx = 0;

  for (const word of words) {
    if (current.length + word.length + 1 > chunkSize && current.length > 100) {
      chunks.push({
        id: baseId + '_' + idx,
        text: current.trim(),
        subject: subject,
        topic: current.trim().split(' ').slice(0, 8).join(' '),
        learning_style: 'all',
        level: 'Class ' + classLevel,
        exam_relevance: 'CBSE,NCERT',
        content_type: 'ncert_textbook'
      });
      idx++;
      current = word;
    } else {
      current += (current ? ' ' : '') + word;
    }
  }

  if (current.trim().length > 50) {
    chunks.push({
      id: baseId + '_' + idx,
      text: current.trim(),
      subject: subject,
      topic: current.trim().split(' ').slice(0, 8).join(' '),
      learning_style: 'all',
      level: 'Class ' + classLevel,
      exam_relevance: 'CBSE,NCERT',
      content_type: 'ncert_textbook'
    });
  }

  return chunks;
}

async function upsertToPinecone(chunks) {
  const batchSize = 5;
  let total = 0;
  let errors = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const records = batch.map(chunk => ({
      _id: chunk.id,
      chunk_text: chunk.text.substring(0, 900),
      subject: chunk.subject,
      topic: chunk.topic.substring(0, 80),
      learning_style: chunk.learning_style,
      level: chunk.level,
      exam_relevance: chunk.exam_relevance,
      content_type: chunk.content_type
    }));

    try {
      const res = await fetch(PINECONE_HOST + '/records/upsert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': PINECONE_API_KEY
        },
        body: JSON.stringify({ namespace: 'teaching-content', records })
      });

      if (res.ok) {
        total += batch.length;
        console.log('Batch OK total=' + total);
      } else {
        const err = await res.text();
        console.error('Batch FAILED status=' + res.status + ' err=' + err);
        errors++;
      }
    } catch(e) {
      console.error('Batch exception: ' + e.message);
      errors++;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  if (total === 0) throw new Error('All ' + errors + ' batches failed');
  return total;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  if (!PINECONE_API_KEY || !PINECONE_HOST) return res.status(500).json({ error: 'Missing Pinecone env vars' });

  try {
    const { text, filename, subject, classLevel } = req.body;

    if (!text || text.length < 50) return res.status(400).json({ error: 'No text received' });

    console.log('[UPLOAD] ' + filename + ' | ' + subject + ' | Class ' + classLevel + ' | ' + text.length + ' chars');

    const chunks = splitIntoChunks(text, subject || 'General', classLevel || '10');
    console.log('[UPLOAD] Created ' + chunks.length + ' chunks');

    if (chunks.length === 0) return res.status(400).json({ error: 'Could not create chunks' });

    const upserted = await upsertToPinecone(chunks);
    console.log('[UPLOAD] Done - ' + upserted + ' chunks ingested');

    return res.status(200).json({ success: true, filename, subject, classLevel, chunks: upserted, characters: text.length });

  } catch (err) {
    console.error('[UPLOAD] Error: ' + err.message);
    return res.status(500).json({ error: err.message });
  }
}
