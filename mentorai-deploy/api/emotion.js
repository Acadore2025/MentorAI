// ============================================================
// api/emotion.js — MentorAI Smart Emotion Detector
// ============================================================
// Called before every AI response
// Reads tone, words, punctuation from student message
// Returns detected emotion + confidence + teaching adjustment
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    // Detect emotion from message + recent history
    const result = detectEmotion(message, history);

    return res.status(200).json(result);

  } catch (err) {
    console.error('Emotion detection error:', err);
    return res.status(200).json({ emotion: 'neutral', confidence: 0, adjustments: {} });
  }
}

// ─────────────────────────────────────────────────────────────
// CORE EMOTION DETECTOR
// Rule-based + pattern matching — no AI call needed (fast)
// ─────────────────────────────────────────────────────────────
function detectEmotion(message, history) {
  const msg = message.toLowerCase().trim();
  const scores = {};

  // ── Emotion signal patterns ───────────────────────────────
  const signals = {

    panicked: {
      keywords: [
        'exam tomorrow', 'exam today', 'test tomorrow', 'test today',
        'paper tomorrow', 'haven\'t studied', 'haven\'t read anything',
        'know nothing', 'don\'t know anything', 'completely blank',
        'running out of time', 'no time left', 'only hours left',
        'help me fast', 'urgent', 'emergency', 'please fast'
      ],
      patterns: [/exam.{0,10}tomorrow/i, /test.{0,10}tomorrow/i, /\d+\s*hours?\s*left/i],
      punctuation: ['!!!', '??!', '!?'],
      weight: 3
    },

    frustrated: {
      keywords: [
        'still don\'t get it', 'still not understanding', 'tried everything',
        'been trying', 'hours and still', 'can\'t understand', 'cannot understand',
        'not getting it', 'making no sense', 'makes no sense',
        'useless', 'pointless', 'waste of time', 'so hard', 'too hard',
        'giving up', 'want to give up', 'hate this', 'hate studying',
        'why am i even', 'what\'s the point', 'so stupid', 'i\'m stupid'
      ],
      patterns: [/tried.{0,20}(times|again|still)/i, /\d+\s*(hours?|hrs?).{0,10}(still|and)/i],
      punctuation: ['ugh', 'argh', 'ugh!'],
      weight: 2
    },

    confused: {
      keywords: [
        'don\'t understand', 'do not understand', 'confused', 'confusing',
        'not clear', 'unclear', 'what does this mean', 'what is this',
        'explain again', 'can you re-explain', 'didn\'t get that',
        'lost me', 'you lost me', 'went over my head', 'too fast',
        'what', 'huh', 'i\'m lost', 'how does this work', 'why does this'
      ],
      patterns: [/explain.{0,10}again/i, /don.?t.{0,10}(get|understand)/i],
      punctuation: ['??', '???'],
      weight: 2
    },

    anxious: {
      keywords: [
        'worried', 'nervous', 'scared', 'fear', 'anxiety', 'anxious',
        'what if i fail', 'going to fail', 'will i pass', 'afraid',
        'stress', 'stressed', 'pressure', 'overwhelming', 'overwhelmed',
        'can\'t focus', 'mind is blank', 'blanking out', 'freezing up',
        'parents will', 'family pressure', 'everyone expects'
      ],
      patterns: [/what if.{0,20}fail/i, /going to fail/i],
      punctuation: [],
      weight: 2
    },

    demotivated: {
      keywords: [
        'what\'s the point', 'why study', 'why even bother', 'don\'t want to',
        'no motivation', 'not motivated', 'can\'t bring myself',
        'don\'t feel like', 'feeling lazy', 'procrastinating',
        'nothing matters', 'bored', 'boring', 'dull', 'so dull',
        'i quit', 'i give up', 'not for me', 'maybe this isn\'t for me'
      ],
      patterns: [/why (even|should i|bother)/i, /what.s the point/i],
      punctuation: ['...', '….'],
      weight: 2
    },

    excited: {
      keywords: [
        'this is amazing', 'so cool', 'love this', 'this is great',
        'finally understand', 'got it!', 'ohh i see', 'oh wow',
        'makes sense now', 'clicked', 'it clicked', 'eureka',
        'can\'t wait', 'excited', 'awesome', 'brilliant', 'mind blown',
        'never knew this', 'this is so interesting', 'fascinating'
      ],
      patterns: [/finally.{0,10}(get|understand|got)/i, /makes.{0,10}sense.{0,10}now/i],
      punctuation: ['!', '!!', ':)', ':D', '🤩', '🔥', '💡'],
      weight: 2
    },

    confident: {
      keywords: [
        'got it', 'understood', 'i get it', 'clear now', 'makes sense',
        'easy', 'simple', 'no problem', 'sure', 'i know this',
        'ready for next', 'what\'s next', 'next topic', 'more please',
        'give me harder', 'challenge me', 'bring it on'
      ],
      patterns: [/what.?s next/i, /(understood|got it|clear now)/i],
      punctuation: [],
      weight: 1
    },

    tired: {
      keywords: [
        'tired', 'exhausted', 'sleepy', 'can\'t focus', 'losing focus',
        'mind wandering', 'blank', 'zoning out', 'need a break',
        'been studying all day', 'studied for hours', 'burning out',
        'burnout', 'drained', 'no energy', 'low energy'
      ],
      patterns: [/studied.{0,20}(all day|hours|long)/i, /need.{0,10}break/i],
      punctuation: [],
      weight: 2
    }
  };

  // ── Score each emotion ────────────────────────────────────
  for (const [emotion, config] of Object.entries(signals)) {
    let score = 0;

    // Keyword matches
    for (const keyword of config.keywords) {
      if (msg.includes(keyword)) score += config.weight;
    }

    // Pattern matches (stronger signal)
    for (const pattern of config.patterns) {
      if (pattern.test(msg)) score += config.weight * 1.5;
    }

    // Punctuation signals
    for (const punct of config.punctuation) {
      if (msg.includes(punct)) score += 1;
    }

    if (score > 0) scores[emotion] = score;
  }

  // ── Check message length and caps for extra signals ───────
  const wordCount = msg.split(' ').length;
  const capsRatio = (message.match(/[A-Z]/g) || []).length / message.length;

  // Very short messages often = confused or frustrated
  if (wordCount <= 3 && !scores.confident) {
    scores.confused = (scores.confused || 0) + 1;
  }

  // ALL CAPS = strong emotion
  if (capsRatio > 0.5 && message.length > 5) {
    scores.panicked = (scores.panicked || 0) + 2;
    scores.frustrated = (scores.frustrated || 0) + 1;
  }

  // ── Check history for persistent patterns ─────────────────
  if (history.length >= 3) {
    const recentMessages = history.slice(-4).map(m => m.content?.toLowerCase() || '');
    const repeatedConfusion = recentMessages.filter(m =>
      m.includes('don\'t understand') || m.includes('confused') || m.includes('explain again')
    ).length;

    if (repeatedConfusion >= 2) {
      scores.frustrated = (scores.frustrated || 0) + 3;
    }
  }

  // ── Pick the dominant emotion ─────────────────────────────
  const dominantEmotion = Object.keys(scores).length > 0
    ? Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b)
    : 'neutral';

  const maxScore = scores[dominantEmotion] || 0;
  const confidence = Math.min(Math.round((maxScore / 6) * 100), 100);

  // ── Build teaching adjustments ────────────────────────────
  const adjustments = getTeachingAdjustments(dominantEmotion, confidence);

  return {
    emotion: dominantEmotion,
    confidence,
    scores,
    adjustments,
    detected: dominantEmotion !== 'neutral'
  };
}

// ─────────────────────────────────────────────────────────────
// TEACHING ADJUSTMENTS
// How the AI should respond differently for each emotion
// ─────────────────────────────────────────────────────────────
function getTeachingAdjustments(emotion, confidence) {
  const adjustments = {

    panicked: {
      tone: 'calm and urgent',
      openWith: 'acknowledge the time pressure first',
      strategy: 'Give a rapid-fire revision plan. Top 5 most important points only. No deep diving.',
      avoid: 'Long explanations, new concepts, anything overwhelming',
      specialInstruction: 'Start with: "Okay, let\'s focus. Here\'s exactly what you need for tomorrow..." Keep it tight and actionable.'
    },

    frustrated: {
      tone: 'empathetic and patient',
      openWith: 'acknowledge their struggle genuinely',
      strategy: 'Try a COMPLETELY different angle. Use a new analogy, new example, new approach.',
      avoid: 'Repeating the same explanation. Being dismissive. Saying "it\'s simple".',
      specialInstruction: 'Start with: "I can see this has been tough. Let\'s approach it differently..." Then use a fresh analogy.'
    },

    confused: {
      tone: 'gentle and clear',
      openWith: 'reassure them that confusion is normal',
      strategy: 'Go back to absolute basics. One concept at a time. Smaller steps.',
      avoid: 'Technical jargon, multiple concepts at once, assuming prior knowledge',
      specialInstruction: 'Start simpler than you think you need to. Build up slowly.'
    },

    anxious: {
      tone: 'warm and reassuring',
      openWith: 'address the anxiety directly before any content',
      strategy: 'Normalise. Share that many students feel this. Then gently guide to the content.',
      avoid: 'Jumping straight to content, dismissing feelings, adding more pressure',
      specialInstruction: 'First 2 sentences must address the feeling. Then transition naturally to studying.'
    },

    demotivated: {
      tone: 'energising and connecting',
      openWith: 'find their WHY before explaining the WHAT',
      strategy: 'Connect the topic to their actual goal. Make it relevant. Tell a story of someone who used this.',
      avoid: 'Lecturing, pushing hard, making them feel guilty',
      specialInstruction: 'Ask one question: "What made you want to study this originally?" Then connect their answer to the topic.'
    },

    excited: {
      tone: 'energetic and expansive',
      openWith: 'match their energy and celebrate the moment',
      strategy: 'Go deeper. Add fascinating connections. Give them the advanced version.',
      avoid: 'Slowing down, being boring, giving basic content',
      specialInstruction: 'Match their excitement! Then take them one level deeper than they expected.'
    },

    confident: {
      tone: 'peer-level and challenging',
      openWith: 'confirm their understanding briefly',
      strategy: 'Move faster. Increase difficulty. Give them a challenge problem.',
      avoid: 'Over-explaining what they already know, being patronising',
      specialInstruction: 'Validate quickly then raise the bar: "Great — now try this harder version..."'
    },

    tired: {
      tone: 'gentle and concise',
      openWith: 'acknowledge their fatigue',
      strategy: 'Short session. Key points only. Suggest a break if needed.',
      avoid: 'Long content, complex topics, high-intensity practice',
      specialInstruction: 'Keep response short. End with: "That\'s enough for now — even 10 minutes of rest will help retention."'
    },

    neutral: {
      tone: 'warm and engaging',
      openWith: 'dive straight into helping',
      strategy: 'Normal teaching mode. Engaging, clear, conversational.',
      avoid: 'Nothing specific',
      specialInstruction: ''
    }
  };

  return adjustments[emotion] || adjustments.neutral;
}
