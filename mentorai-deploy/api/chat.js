// ============================================================
// api/chat.js — MentorAI Brain
// ============================================================
// Flow:
// 1. Read student profile (learning style, emotion, level)
// 2. Detect what student needs (teach / flashcard / practice)
// 3. Search Pinecone for right content in their style
// 4. Build teaching prompt combining profile + content
// 5. AI teaches in the student's OWN way
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body;
    const messages       = body.messages || [];
    const studentProfile = body.profile  || {};
    const baseSystem     = body.system   || '';
    const model          = body.model    || 'openai';

    const userMessage = messages[messages.length - 1]?.content || '';

    // Step 1: Who is this student?
    const student = extractStudentContext(studentProfile);

    // Step 2: What does this message need?
    const intent = detectIntent(userMessage);

    // Step 2b: Auto-detect emotion from message
    const emotionData = detectEmotionFromMessage(userMessage, messages.slice(-4));
    if (emotionData.detected) {
      console.log('💭 Emotion detected:', emotionData.emotion, '| confidence:', emotionData.confidence + '%');
      // Override profile emotion with detected emotion if confidence is high enough
      if (emotionData.confidence >= 40) {
        student.emotion = emotionData.emotion;
        student.emotionAdjustments = emotionData.adjustments;
      }
    }

    // Step 3: Search knowledge base if teaching needed
    let ragContext = '';
    if (intent.needsKnowledge) {
      ragContext = await searchKnowledge(userMessage, student.learning_style, intent.subject, intent.content_type);
    }

    // Step 3b: Web search if current affairs / news needed
    let webContext = '';
    console.log('🔍 needsWebSearch:', intent.needsWebSearch, '| message:', userMessage);
    if (intent.needsWebSearch) {
      console.log('🌐 Calling Tavily for:', userMessage);
      webContext = await searchWeb(userMessage);
      console.log('✅ Tavily returned:', webContext ? webContext.slice(0, 200) : 'EMPTY');
    }

    // Step 4: Build the full teaching prompt
    const systemPrompt = buildTeachingPrompt(baseSystem, student, ragContext, intent, webContext);

    // Step 5: Inject web context directly into messages if available
    let finalMessages = messages;
    if (webContext) {
      const lastUserMsg = finalMessages[finalMessages.length - 1];
      finalMessages = [
        ...finalMessages.slice(0, -1),
        {
          role: 'user',
          content: `IMPORTANT INSTRUCTIONS:
- You have NO independent knowledge of current events, news, or anything after 2023.
- The ONLY source of truth for current information is the web search data below.
- You MUST use this data to answer. Do NOT fall back to your training data.
- If the web search data answers the question — use it directly and cite it.

[LIVE WEB SEARCH DATA]:
${webContext}

[USER QUESTION]: ${lastUserMsg.content}`
        }
      ];
    }

    // Step 6: Smart model selection
    // gpt-4o for live web search (accuracy critical)
    // gpt-4o-mini for teaching/concepts (speed + cost)
    const smartModel = webContext ? 'gpt-4o' : 'openai';
    const response = await callAI(smartModel, finalMessages, systemPrompt);

    return res.status(200).json(response);

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// WHO IS THIS STUDENT
// ─────────────────────────────────────────────────────────────
function extractStudentContext(profile) {
  const personalityToStyle = {
    'The Explorer':    'hands_on',
    'The Achiever':    'logical',
    'The Connector':   'story',
    'The Overthinker': 'logical',
    'The Grower':      'visual',
    'The Dreamer':     'story',
    'The Analyst':     'logical',
    'The Creator':     'visual'
  };

  return {
    name:            profile.name             || 'Student',
    learning_style:  profile.learning_style   || personalityToStyle[profile.personality_type] || 'visual',
    personality:     profile.personality_type || 'The Grower',
    level:           profile.academic_level   || 'Class 11',
    exam_target:     profile.exam_target      || 'CBSE',
    emotion:         profile.current_emotion  || 'neutral',
    weak_subjects:   profile.weak_subjects    || [],
    strong_subjects: profile.strong_subjects  || []
  };
}

// ─────────────────────────────────────────────────────────────
// WHAT DOES THIS MESSAGE NEED
// ─────────────────────────────────────────────────────────────
function detectIntent(message) {
  const msg = message.toLowerCase();

  const isTeaching  = ['explain','teach','what is','how does','tell me','understand','define','concept','show me','what are'].some(k => msg.includes(k));
  const isFlashcard = ['flashcard','quiz me','test me','quick revision','revise'].some(k => msg.includes(k));
  const isPractice  = ['practice','question','problem','solve','exercise','example','give me a'].some(k => msg.includes(k));
  const isEmotional = ['stressed','anxious','scared','worried','overwhelmed','tired','frustrated','can\'t focus'].some(k => msg.includes(k));

  // Detect if web search is needed
  const webSearchKeywords = [
    // Time-based
    'today','yesterday','this week','this month','this year',
    'latest','recent','current','now','right now','new',
    '2024','2025','2026',
    // News & events
    'news','happened','update','announce','launch','release',
    'who is','who won','who became','who got','who is the',
    // Exams & results
    'exam date','notification','result','cutoff','vacancy','recruitment',
    'admit card','syllabus change','new pattern','upsc 2','ssc 2',
    'ibps','sbi po','neet 2','jee 2','cat 2','gate 2',
    // Government & policy
    'election','government','policy','scheme','budget','parliament',
    'prime minister','president','minister','bill','act passed',
    // Economy & finance
    'price','rate','repo rate','inflation','gdp','rbi','sebi',
    'stock','market','sensex','nifty','rupee','dollar',
    // Sports & entertainment
    'ipl','cricket','football','olympics','world cup','match',
    // General knowledge queries
    'how many','how much','when did','when was','where is',
    'what happened','tell me about recent','any news'
  ];
  const needsWebSearch = webSearchKeywords.some(k => msg.includes(k));

  let subject = null;
  if (['physics','newton','force','motion','electricity','light','pressure'].some(k => msg.includes(k))) subject = 'Physics';
  if (['chemistry','atom','reaction','acid','base','periodic','molecule'].some(k => msg.includes(k))) subject = 'Chemistry';
  if (['biology','cell','photosynthesis','gene','evolution','organ'].some(k => msg.includes(k))) subject = 'Biology';
  if (['math','algebra','percentage','trigonometry','calculus','geometry','statistics'].some(k => msg.includes(k))) subject = 'Mathematics';
  if (['cat','mba','reasoning','aptitude','seating','arrangement','data interpretation'].some(k => msg.includes(k))) subject = 'CAT / MBA Preparation';

  return {
    needsKnowledge: isTeaching || isFlashcard || isPractice,
    needsWebSearch,
    wantsFlashcards: isFlashcard,
    wantsPractice:   isPractice,
    isEmotional,
    subject,
    content_type: isFlashcard ? 'flashcards' : isPractice ? 'practice' : 'teaching'
  };
}

// ─────────────────────────────────────────────────────────────
// SEARCH PINECONE FOR RIGHT CONTENT
// ─────────────────────────────────────────────────────────────
async function searchKnowledge(query, learning_style, subject, content_type) {
  try {
    const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
    const PINECONE_HOST    = process.env.PINECONE_HOST;
    if (!PINECONE_API_KEY || !PINECONE_HOST) return '';

    const styleWords = {
      visual:   'visual diagram draw picture see',
      hands_on: 'experiment practical hands-on activity try',
      story:    'story narrative history tell explain',
      logical:  'logical proof formula derive step-by-step'
    }[learning_style] || '';

    const enrichedQuery = `${query} ${styleWords} ${subject || ''}`.trim();

    const searchRes = await fetch(`${PINECONE_HOST}/records/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': PINECONE_API_KEY },
      body: JSON.stringify({
        namespace: 'teaching-content',
        query: { inputs: { chunk_text: enrichedQuery }, top_k: 8 },
        fields: ['text', 'subject', 'topic', 'learning_style', 'content_type']
      })
    });

    const data = await searchRes.json();
    const hits = data.result?.hits || data.matches || [];
    if (hits.length === 0) return '';

    // Boost results that match student's learning style
    const ranked = hits
      .map(h => ({
        ...h,
        score: (h._score || 0) +
               (h.fields?.learning_style === learning_style ? 0.5 : 0) +
               (h.fields?.content_type   === content_type   ? 0.3 : 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    const styleLabel = {
      visual:   'Visual learner — loves diagrams and pictures',
      hands_on: 'Hands-on learner — needs experiments and real activities',
      story:    'Story learner — connects through narratives and history',
      logical:  'Logical learner — wants proofs and step-by-step reasoning'
    }[learning_style] || 'Visual learner';

    return `STUDENT'S LEARNING STYLE: ${styleLabel}

RETRIEVED KNOWLEDGE (use this content — deliver in their learning style):
${ranked.map((h, i) => `[${i+1}] ${h.fields?.topic || ''} (${h.fields?.content_type || ''})\n${h.fields?.text || h.fields?.chunk_text || h.metadata?.text || ''}`).join('\n\n---\n\n')}`;

  } catch (err) {
    console.warn('Pinecone search failed:', err.message);
    return '';
  }
}



// ─────────────────────────────────────────────────────────────
// AUTO EMOTION DETECTOR
// Reads tone, words, punctuation — no AI call needed
// ─────────────────────────────────────────────────────────────
function detectEmotionFromMessage(message, history = []) {
  const msg = message.toLowerCase().trim();
  const scores = {};

  const signals = {
    panicked: {
      keywords: ['exam tomorrow','exam today','test tomorrow','haven\'t studied',
        'know nothing','don\'t know anything','running out of time','only hours left',
        'help me fast','urgent','emergency','please fast','paper tomorrow'],
      patterns: [/exam.{0,10}tomorrow/i,/test.{0,10}tomorrow/i,/\d+\s*hours?\s*left/i],
      weight: 3
    },
    frustrated: {
      keywords: ['still don\'t get it','tried everything','been trying','hours and still',
        'can\'t understand','not getting it','makes no sense','useless','waste of time',
        'giving up','want to give up','hate this','i\'m stupid','so stupid','too hard'],
      patterns: [/tried.{0,20}(times|again|still)/i,/\d+\s*(hours?|hrs?).{0,10}(still|and)/i],
      weight: 2
    },
    confused: {
      keywords: ['don\'t understand','do not understand','confused','not clear',
        'explain again','can you re-explain','didn\'t get that','lost me',
        'went over my head','too fast','i\'m lost','huh'],
      patterns: [/explain.{0,10}again/i,/don.?t.{0,10}(get|understand)/i],
      weight: 2
    },
    anxious: {
      keywords: ['worried','nervous','scared','anxiety','anxious','what if i fail',
        'going to fail','stressed','pressure','overwhelming','overwhelmed',
        'can\'t focus','family pressure','parents will'],
      patterns: [/what if.{0,20}fail/i,/going to fail/i],
      weight: 2
    },
    demotivated: {
      keywords: ['what\'s the point','why study','why even bother','no motivation',
        'not motivated','don\'t feel like','feeling lazy','procrastinating',
        'nothing matters','bored','i quit','i give up'],
      patterns: [/why (even|should i|bother)/i,/what.s the point/i],
      weight: 2
    },
    excited: {
      keywords: ['this is amazing','so cool','love this','finally understand','got it!',
        'oh wow','makes sense now','it clicked','mind blown','this is so interesting'],
      patterns: [/finally.{0,10}(get|understand|got)/i,/makes.{0,10}sense.{0,10}now/i],
      weight: 2
    },
    confident: {
      keywords: ['got it','understood','i get it','clear now','makes sense',
        'ready for next','what\'s next','next topic','give me harder','challenge me'],
      patterns: [/what.?s next/i,/(understood|got it|clear now)/i],
      weight: 1
    },
    tired: {
      keywords: ['tired','exhausted','sleepy','can\'t focus','losing focus',
        'need a break','been studying all day','burnout','drained','no energy'],
      patterns: [/studied.{0,20}(all day|hours|long)/i,/need.{0,10}break/i],
      weight: 2
    }
  };

  for (const [emotion, config] of Object.entries(signals)) {
    let score = 0;
    for (const keyword of config.keywords) {
      if (msg.includes(keyword)) score += config.weight;
    }
    for (const pattern of config.patterns) {
      if (pattern.test(msg)) score += config.weight * 1.5;
    }
    if (score > 0) scores[emotion] = score;
  }

  // Short message = likely confused
  const wordCount = msg.split(' ').length;
  if (wordCount <= 3 && !scores.confident) {
    scores.confused = (scores.confused || 0) + 1;
  }

  // ALL CAPS = panicked or frustrated
  const capsRatio = (message.match(/[A-Z]/g) || []).length / message.length;
  if (capsRatio > 0.5 && message.length > 5) {
    scores.panicked  = (scores.panicked  || 0) + 2;
    scores.frustrated = (scores.frustrated || 0) + 1;
  }

  // Repeated confusion in history = frustrated
  if (history.length >= 2) {
    const recentMsgs = history.slice(-4).map(m => (m.content || '').toLowerCase());
    const confusedCount = recentMsgs.filter(m =>
      m.includes('don\'t understand') || m.includes('confused') || m.includes('explain again')
    ).length;
    if (confusedCount >= 2) scores.frustrated = (scores.frustrated || 0) + 3;
  }

  const dominantEmotion = Object.keys(scores).length > 0
    ? Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b)
    : 'neutral';

  const maxScore = scores[dominantEmotion] || 0;
  const confidence = Math.min(Math.round((maxScore / 6) * 100), 100);

  const adjustmentMap = {
    panicked:     { tone: 'calm and urgent',         specialInstruction: 'Start with: "Okay, let\'s focus. Here\'s exactly what you need right now..." Give top 5 key points only. No deep diving.' },
    frustrated:   { tone: 'empathetic and patient',  specialInstruction: 'Acknowledge their struggle first. Then try a COMPLETELY different angle — new analogy, new example.' },
    confused:     { tone: 'gentle and clear',         specialInstruction: 'Go back to absolute basics. One concept at a time. Smaller steps. Simpler language.' },
    anxious:      { tone: 'warm and reassuring',      specialInstruction: 'Address the anxiety in first 2 sentences before any content. Normalise the feeling.' },
    demotivated:  { tone: 'energising',               specialInstruction: 'Connect this topic to their actual goal first. Make it relevant before explaining.' },
    excited:      { tone: 'energetic and expansive',  specialInstruction: 'Match their energy! Then take them one level deeper than they expected.' },
    confident:    { tone: 'peer-level',               specialInstruction: 'Validate quickly then raise the bar: "Great — now try this harder version..."' },
    tired:        { tone: 'gentle and concise',       specialInstruction: 'Keep response short. End with a rest suggestion.' },
    neutral:      { tone: 'warm and engaging',        specialInstruction: '' }
  };

  return {
    emotion: dominantEmotion,
    confidence,
    adjustments: adjustmentMap[dominantEmotion] || adjustmentMap.neutral,
    detected: dominantEmotion !== 'neutral' && confidence >= 30
  };
}

// ─────────────────────────────────────────────────────────────
// SEARCH WEB VIA TAVILY
// Called for current affairs, news, exam notifications etc.
// ─────────────────────────────────────────────────────────────
async function searchWeb(query) {
  try {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    console.log('🔑 TAVILY_API_KEY exists:', !!TAVILY_API_KEY);
    if (!TAVILY_API_KEY) return '';

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true
      })
    });

    const data = await res.json();
    if (!res.ok || !data.results) return '';

    const results = data.results || [];
    let context = `LIVE WEB SEARCH RESULTS for: "${query}"

`;

    if (data.answer) {
      context += `DIRECT ANSWER: ${data.answer}

`;
    }

    context += `SOURCES:
`;
    results.slice(0, 3).forEach((r, i) => {
      context += `[${i+1}] ${r.title}\n${(r.content || '').slice(0, 400)}\nURL: ${r.url}\n\n`;
    });

    return context;

  } catch (err) {
    console.warn('Web search failed (non-critical):', err.message);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// BUILD THE COMPLETE TEACHING PROMPT
// This is the heart of MentorAI
// ─────────────────────────────────────────────────────────────
function buildTeachingPrompt(baseSystem, student, ragContext, intent, webContext = '') {

  const styleInstructions = {
    visual: `TEACHING STYLE — VISUAL LEARNER:
• Start by painting a clear mental image: "Picture this..." or "Imagine you can see..."
• Use diagrams described in words: arrows, boxes, relationships
• Use tables to compare concepts side by side
• Make the invisible visible — describe what things LOOK like`,

    hands_on: `TEACHING STYLE — HANDS-ON LEARNER:
• Start with something they can DO right now: "Try this...", "Do this experiment..."
• Give the experience FIRST — concept explanation comes AFTER they feel it
• Connect every abstract idea to something physical, touchable, testable
• Examples: coins, everyday objects, their own body, things at home`,

    story: `TEACHING STYLE — STORY LEARNER:
• Start with a story, real person, or historical moment — ALWAYS
• "In 1687, Newton was sitting..." / "Imagine you are a merchant in Venice..."
• Make them FEEL part of the narrative before introducing the concept
• Science and math happen to PEOPLE in PLACES — make it human`,

    logical: `TEACHING STYLE — LOGICAL LEARNER:
• Start with a clean definition or first principle
• Show every derivation step — no skipping, no hand-waving
• Use: "Let's prove this formally..." / "From first principles..."
• Connect to mathematical structures, exceptions, and deeper implications`
  };

  const emotionGuides = {
    stressed:   'Student is STRESSED. Acknowledge briefly. Keep explanation short. Break into tiny steps. Extra encouragement.',
    anxious:    'Student is ANXIOUS. Be very gentle. Go slowly. Celebrate every small understanding.',
    frustrated: 'Student is FRUSTRATED. Acknowledge the difficulty. Try a COMPLETELY fresh angle — not same explanation again.',
    confused:   'Student is CONFUSED. Start from absolute basics. Assume zero prior knowledge. Build slowly.',
    curious:    'Student is CURIOUS — best state! Go deeper. Add fascinating connections. Make it exciting.',
    excited:    'Student is EXCITED! Match energy. Keep it dynamic. Move fast but thoroughly.',
    neutral:    'Normal engagement. Warm, clear, conversational.'
  };

  const deliveryFormats = {
    flashcards: `DELIVERY: Flashcard mode.
Format each card as:
🃏 Q: [question]
✅ A: [answer]
Give 5 flashcards. After all 5 ask: "Want 5 more or shall we practice with questions?"`,

    practice: `DELIVERY: Practice mode.
1. Give ONE practice problem at their level
2. Let them attempt (end with "Try it — what do you get?")
3. After they respond, walk through full solution step by step
4. End with one slightly harder follow-up`,

    teaching: `DELIVERY: Teaching mode.
1. HOOK (1-2 sentences in their learning style — grab attention)
2. CORE CONCEPT (explained in their style — not textbook language)
3. REAL WORLD CONNECTION (something they can relate to personally)
4. CHECK IN: End with "Does that click? Or should we try a different angle?"`
  };

  const deliveryFormat = deliveryFormats[intent.content_type] || deliveryFormats.teaching;
  const styleGuide     = styleInstructions[student.learning_style] || styleInstructions.visual;
  const emotionGuide   = emotionGuides[student.emotion?.toLowerCase()] || emotionGuides.neutral;
  const specialInstruction = student.emotionAdjustments?.specialInstruction || '';

  let prompt = `${baseSystem}

════════════════════════════════════════
STUDENT PROFILE — READ THIS FIRST
════════════════════════════════════════
Name: ${student.name}
Learning Style: ${student.learning_style.toUpperCase()} ← MOST IMPORTANT
Personality: ${student.personality}
Level: ${student.level}
Target Exam: ${student.exam_target}
Emotion Right Now: ${student.emotion}
Weak Areas: ${student.weak_subjects.join(', ') || 'None specified'}

════════════════════════════════════════
EMOTION GUIDANCE
════════════════════════════════════════
${emotionGuide}

════════════════════════════════════════
${styleGuide}

════════════════════════════════════════
${deliveryFormat}
════════════════════════════════════════

NON-NEGOTIABLE RULES:
1. NEVER start with a textbook definition
2. ALWAYS start with their learning style hook
3. Use ${student.name}'s name at least once naturally
4. If confused — try a DIFFERENT angle, not the same explanation
5. You are their personal mentor — warm, patient, specific to THEM
6. Keep responses focused — do not overwhelm with too much at once
7. NEVER say "I don't have access to real-time data" or "my training cutoff" — you have live web search. USE IT.
8. If web search results are provided below — USE THEM to answer. Always.`;

  if (ragContext) {
    prompt += `

════════════════════════════════════════
KNOWLEDGE BASE — YOUR TEACHING MATERIAL
════════════════════════════════════════
${ragContext}

⚠️ USE the knowledge above as your source.
⚠️ TRANSFORM it into ${student.name}'s learning style — do NOT copy verbatim.
⚠️ Deliver it the way a ${student.learning_style} learner needs it.`;
  }

  // Inject emotion-based instruction if detected with confidence
  if (specialInstruction) {
    prompt += `

════════════════════════════════════════
EMOTION DETECTED: ${student.emotion.toUpperCase()}
════════════════════════════════════════
PRIORITY INSTRUCTION FOR THIS RESPONSE: ${specialInstruction}
This overrides your default response style for this one message.`;
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────
// AI MODEL CALLS
// ─────────────────────────────────────────────────────────────
async function callAI(model, messages, system) {
  if (model === 'claude') return callClaude(messages, system);
  if (model === 'gemini') return callGemini(messages, system);
  if (model === 'gpt-4o') return callOpenAI(messages, system, 'gpt-4o');
  return callOpenAI(messages, system, 'gpt-4o-mini');
}

async function callOpenAI(messages, system, modelName = 'gpt-4o-mini') {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1200,
      temperature: 0.7
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { content: data.choices[0].message.content, model: 'openai', usage: data.usage };
}

async function callClaude(messages, system) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 1200, system, messages })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { content: data.content[0].text, model: 'claude', usage: data.usage };
}

async function callGemini(messages, system) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 1200, temperature: 0.7 }
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { content: data.candidates[0].content.parts[0].text, model: 'gemini' };
}
