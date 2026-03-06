// api/upload.js - MentorAI PDF Ingestion
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
        _id: baseId + '_' + idx,
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
      _id: baseId + '_' + idx,
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
  const batchSize = 10;
  let total = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const res = await fetch(PINECONE_HOST + '/records/namespaces/teaching-content/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PINECONE_API_KEY
      },
      body: JSON.stringify({ records: batch })
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.error('Pinecone error ' + res.status + ': ' + rawText);
      throw new Error('Pinecone error ' + res.status + ': ' + rawText);
    }

    total += batch.length;
    console.log('Batch done, total: ' + total);
    await new Promise(r => setTimeout(r, 300));
  }

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

    console.log('[UPLOAD] ' + filename + ' | ' + subject + ' | ' + text.length + ' chars');

    const chunks = splitIntoChunks(text, subject || 'General', classLevel || '10');
    console.log('[UPLOAD] Created ' + chunks.length + ' chunks');

    const upserted = await upsertToPinecone(chunks);
    console.log('[UPLOAD] Done - ' + upserted + ' chunks');

    return res.status(200).json({ success: true, filename, subject, classLevel, chunks: upserted, characters: text.length });

  } catch (err) {
    console.error('[UPLOAD] Error: ' + err.message);
    return res.status(500).json({ error: err.message });
  }
}
