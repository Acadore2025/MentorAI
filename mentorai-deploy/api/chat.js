// ============================================================
// api/chat.js - MentorAI Brain
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
    let messages         = body.messages || [];
    const studentProfile = body.profile  || {};
    const baseSystem     = body.system   || '';
    const model          = body.model    || 'openai';

    const userMessage = messages[messages.length - 1]?.content || '';

    // Step 1: Who is this student?
    const student = extractStudentContext(studentProfile);

    // Step 2: Agent routes the message intelligently
    const intent = detectIntent(userMessage, student, messages);

    // Step 2b: Auto-detect emotion from message
    const emotionData = detectEmotionFromMessage(userMessage, messages.slice(-4));
    if (emotionData.detected) {
      console.log('? Emotion detected:', emotionData.emotion, '| confidence:', emotionData.confidence + '%');
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
    console.log('[SEARCH] needsWebSearch:', intent.needsWebSearch, '| message:', userMessage);
    if (intent.needsWebSearch) {
      console.log('[WEB] Calling Tavily for:', userMessage);
      webContext = await searchWeb(userMessage);
      console.log('[OK] Tavily returned:', webContext ? webContext.slice(0, 200) : 'EMPTY');

      if (webContext) {
        const needsLiveDisclaimer = /live|score|right now|this minute|real.?time|breaking|stock price|share price|crypto/i.test(userMessage);
        if (needsLiveDisclaimer) {
          webContext += `

[WARN]? IMPORTANT: End your response with this exact line:
"[SIGNAL] This is based on the latest available information. For live updates, check the relevant source (Cricinfo / NSE / Google News) directly."`;
        } else {
          webContext += `

[PIN] IMPORTANT: End your response with this line:
"[SIGNAL] Based on latest available information. Data may have changed - verify from primary sources."`;
        }
      }
    }

    // Step 4b: Socratic intake - figure out next question BEFORE building prompt
    let socraticInstruction = '';
    if (intent.mode === 'socratic_intake') {
      const recentExchange = messages.slice(-8).map(m => m.content || '').join(' ').toLowerCase();

      const isStudyPlan = recentExchange.match(/study plan|make a plan|create a plan|help me prepare|how should i prepare|prepare for/i);
      const isInterview = recentExchange.match(/interview/i);

      const knowsCompany  = recentExchange.match(/accenture|genpact|google|amazon|flipkart|tcs|infosys|wipro|microsoft|meta|deloitte|capgemini|cognizant|hcl|startup|mnc/i);
      const knowsLevel    = recentExchange.match(/beginner|intermediate|senior|years of exp|i know|i dont know|nothing|basics|comfortable|solid|decent|some exp/i);
      const knowsTime     = recentExchange.match(/\d+\s*(hour|hr|hrs)|hour a day|hours a day|per day|daily|tonight|all day/i);
      const knowsHours    = recentExchange.match(/\d+\s*(hour|hr|hrs)|hour a day|hours a day|per day|daily/i);
      const knowsDeadline = recentExchange.match(/\d+\s*(day|week|month|year)|jee|neet|upsc|cat|gate|exam date|deadline/i);
      const knowsWeak     = recentExchange.match(/weak|struggle|bad at|not good|difficult|hard for me|confused about/i);

      if (isStudyPlan) {
        if (!knowsHours)    socraticInstruction = 'how many hours a day can you realistically give?';
        else if (!knowsDeadline) socraticInstruction = 'what is your target date or deadline?';
        else if (!knowsWeak)     socraticInstruction = 'which subjects or topics feel weakest right now?';
        else                     socraticInstruction = 'DONE_DIAGNOSING';
      } else if (isInterview) {
        if (!knowsCompany)  socraticInstruction = 'which company is it for?';
        else if (!knowsLevel)    socraticInstruction = 'how comfortable are you with the relevant skills - beginner, some experience, or fairly solid?';
        else if (!knowsTime)     socraticInstruction = 'how many hours do you have to prepare?';
        else                     socraticInstruction = 'DONE_DIAGNOSING';
      } else {
        if (!knowsLevel)    socraticInstruction = 'what is your current level with this?';
        else if (!knowsTime)     socraticInstruction = 'how much time do you have?';
        else                     socraticInstruction = 'DONE_DIAGNOSING';
      }

      // If done diagnosing - switch to normal teaching mode
      if (socraticInstruction === 'DONE_DIAGNOSING') {
        intent.mode = 'teaching';
        socraticInstruction = '';
      }
    }

    // Step 4: Build the full teaching prompt (now with socraticInstruction available)
    intent._socraticInstruction = socraticInstruction;
    // -- SOLID TIME COMPASS - injected on every request ----------
    const _now        = new Date();
    const _year       = _now.getFullYear();
    const _month      = _now.toLocaleString('en-US', { month: 'long' });
    const _date       = _now.getDate();
    const _weekday    = _now.toLocaleString('en-US', { weekday: 'long' });
    const _yesterday  = new Date(_now); _yesterday.setDate(_date - 1);
    const _lastWeek   = new Date(_now); _lastWeek.setDate(_date - 7);
    const _lastMonth  = new Date(_now); _lastMonth.setMonth(_now.getMonth() - 1);
    const _lastYear   = _year - 1;

    const timeCompass = `
========================================
INTERNAL TIME COMPASS - READ BEFORE EVERY RESPONSE
========================================
Current date    : ${_weekday}, ${_month} ${_date}, ${_year}
Yesterday       : ${_yesterday.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}
Last week       : week of ${_lastWeek.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}
Last month      : ${_lastMonth.toLocaleString('en-US', { month:'long', year:'numeric' })}
Last year       : ${_lastYear}
Current year    : ${_year}

TIME RULES - NON-NEGOTIABLE:
1. "Today" = ${_weekday}, ${_month} ${_date}, ${_year}. Not 2024. Not 2025. This exact date.
2. "Yesterday" = ${_yesterday.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}
3. "This year" = ${_year}. "Last year" = ${_lastYear}.
4. "Latest" or "recent" = must be from ${_year}, not older.
5. If web search results mention a different year - IGNORE those results. Only use ${_year} data.
6. If no ${_year} data exists in search results - say "I could not find confirmed ${_year} data" - never substitute old data.
7. NEVER present a past event as current. NEVER guess. If unsure - say so.
8. Sports results, news, prices, elections, rankings - ALL must be verified against ${_year}.
========================================`;

    const baseSystemWithDate = `${timeCompass}\n\n${baseSystem}`;
    const systemPrompt = buildTeachingPrompt(baseSystemWithDate, student, ragContext, intent, webContext);

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
- If the web search data answers the question - use it directly and cite it.

[LIVE WEB SEARCH DATA]:
${webContext}

[USER QUESTION]: ${lastUserMsg.content}`
        }
      ];
    }

    // Step 6: Smart model selection
    // gpt-4o for live web search (accuracy critical)
    // gpt-4o for all responses - mini cannot follow complex instructions
    const smartModel = 'gpt-4o';

    const response = await callAI(smartModel, finalMessages, systemPrompt);
    return res.status(200).json(response);

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// -------------------------------------------------------------
// WHO IS THIS STUDENT
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// LANGGRAPH-STYLE AGENT ROUTER
// Analyses full context - decides which tools to run + order
// Much smarter than keyword matching
// -------------------------------------------------------------
function detectIntent(message, student = {}, history = []) {
  const msg = message.toLowerCase().trim();

  // -- SUBJECT DETECTION -------------------------------------
  let subject = null;
  const subjectMap = {
    'Physics':               ['physics','newton','force','motion','velocity','acceleration','electricity','magnetism','light','optics','pressure','thermodynamics','quantum','wave','energy','power','momentum','gravitation'],
    'Chemistry':             ['chemistry','atom','reaction','acid','base','periodic','molecule','bond','element','compound','organic','inorganic','mole','oxidation','reduction','electrode','catalyst'],
    'Biology':               ['biology','cell','photosynthesis','gene','dna','rna','evolution','organ','tissue','enzyme','hormone','ecosystem','nutrition','respiration','reproduction'],
    'Mathematics':           ['math','maths','algebra','percentage','trigonometry','calculus','geometry','statistics','probability','matrix','derivative','integral','equation','polynomial','sequence','series'],
    'CAT / MBA Preparation': ['cat','mba','reasoning','aptitude','seating','arrangement','data interpretation','logical','verbal','quant','di','lr','va','rc'],
    'UPSC':                  ['upsc','ias','ips','polity','constitution','history','geography','economy','governance','international','current affairs','prelims','mains'],
    'SSC':                   ['ssc','cgl','chsl','gd','constable','quantitative','english grammar','general awareness'],
    'Banking':               ['banking','ibps','sbi','rbi','po','clerk','financial awareness','banking awareness','money market']
  };

  for (const [sub, keywords] of Object.entries(subjectMap)) {
    if (keywords.some(k => msg.includes(k))) { subject = sub; break; }
  }

  // -- INTENT SIGNALS ----------------------------------------
  const signals = {
    // Teaching signals
    wantsExplanation: ['explain','teach','what is','how does','tell me about','help me understand',
      'define','concept','show me','what are','how do','why does','describe','elaborate','break down'].some(k => msg.includes(k)),

    // Flashcard signals
    wantsFlashcards: ['flashcard','flash card','quiz me','test me','quick revision','revise',
      'rapid fire','quick test','memory test','recall'].some(k => msg.includes(k)),

    // Practice signals
    wantsPractice: ['practice','give me a question','problem','solve','exercise',
      'example question','mock','attempt','try me','challenge me','harder question',
      'previous year','pyq','past paper'].some(k => msg.includes(k)),

    // Emotional signals
    needsSupport: ['stressed','anxious','scared','worried','overwhelmed','tired',
      'frustrated','cant focus','giving up','hopeless','demotivated','no motivation',
      'whats the point','want to quit','lost','help'].some(k => msg.includes(k)),

    // Comparison / decision signals  
    wantsComparison: ['difference between','compare','vs','versus','which is better',
      'whats better','distinguish','contrast','similarities'].some(k => msg.includes(k)),

    // Summary signals
    wantsSummary: ['summarize','summary','overview','brief','tldr','in short',
      'key points','main points','gist','recap'].some(k => msg.includes(k)),

    // Study plan signals
    wantsStudyPlan: ['study plan','schedule','timetable','how to prepare','preparation plan',
      'strategy','roadmap','how many days','how long to prepare'].some(k => msg.includes(k)),

    // Web search signals
    needsWebSearch: [
      'today','yesterday','this week','this month','this year',
      'latest','recent','current','now','right now',
      '2024','2025','2026',
      'news','happened','update','announced','launched',
      'who is','who won','who became','who got',
      'exam date','notification','result','cutoff','vacancy','recruitment',
      'admit card','syllabus 2025','new pattern',
      'upsc 2025','ssc 2025','ibps 2025','sbi po 2025','neet 2025','jee 2025','cat 2025',
      'election','government policy','new scheme','budget 2025','parliament',
      'prime minister','president','minister','new bill',
      'repo rate','inflation rate','gdp growth','rbi policy','sebi',
      'stock market','sensex','nifty','rupee','dollar rate',
      'ipl','cricket','football','olympics','world cup',
      'how many','what happened','any news','tell me about recent'
    ].some(k => msg.includes(k))
  };

  // -- CONTEXT-AWARE ROUTING ---------------------------------
  // Check conversation history for context
  const recentHistory = history.slice(-4).map(m => (m.content || '').toLowerCase());
  const isFollowUp = recentHistory.length > 0;
  const prevWasPractice = recentHistory.some(m => m.includes('try') || m.includes('solve') || m.includes('attempt'));

  // -- MULTI-TOOL DECISION ENGINE ----------------------------
  // Unlike simple keyword matching, this decides COMBINATIONS

  // SCENARIO 1: Emotional + Academic = support first, then teach
  const needsEmotionalFirst = signals.needsSupport && (signals.wantsExplanation || subject);

  // SCENARIO 2: Web + Teaching = search live data + explain concept
  const needsWebAndTeach = signals.needsWebSearch && (signals.wantsExplanation || subject);

  // SCENARIO 3: Exam panic = rapid revision mode
  const isExamPanic = msg.includes('exam') && (msg.includes('tomorrow') || msg.includes('today') || msg.includes('tonight'));

  // SCENARIO 4: Follow-up after practice = check answer + next problem
  const isAnswerAttempt = prevWasPractice && !signals.wantsExplanation && msg.length < 100;

  // SCENARIO 5: Pure conversation (greeting, thanks, general chat)
  const isPureConversation = !subject && !signals.wantsExplanation && !signals.wantsPractice &&
    !signals.wantsFlashcards && !signals.needsWebSearch && !signals.needsSupport &&
    ['hi','hello','hey','thanks','thank you','ok','okay','great','nice','cool','bye'].some(k => msg.includes(k));

  // -- DETERMINE PRIMARY MODE --------------------------------
  let mode = 'teaching'; // default
  if (signals.wantsFlashcards)  mode = 'flashcards';
  if (signals.wantsPractice)    mode = 'practice';
  if (signals.wantsSummary)     mode = 'summary';
  if (signals.wantsStudyPlan)   mode = 'study_plan';
  if (signals.wantsComparison)  mode = 'comparison';
  if (signals.needsSupport && !subject) mode = 'emotional_support';
  if (isExamPanic)              mode = 'exam_panic';
  if (isAnswerAttempt)          mode = 'check_answer';
  if (isPureConversation)       mode = 'conversation';

  // -- BUILD TOOL SEQUENCE -----------------------------------
  const tools = [];
  if (signals.needsWebSearch)                                    tools.push('web_search');
  if (signals.wantsExplanation || subject || signals.wantsPractice || signals.wantsFlashcards) tools.push('knowledge_base');
  if (signals.needsSupport || needsEmotionalFirst)               tools.push('emotional_support');

  // -- SOCRATIC INTAKE DETECTION ----------------------------
  const socraticTriggers = [
    // Interview
    'interview tomorrow','interview today','interview this week',
    'got an interview','have an interview','i have an interview',
    // Exam
    'exam tomorrow','exam today','exam this week',
    'test tomorrow','test today','paper tomorrow','viva tomorrow',
    // Presentation
    'presentation tomorrow','presentation today','demo tomorrow','present tomorrow',
    // Study plan - needs diagnosis before building
    'make a study plan','make me a study plan','create a study plan',
    'study plan','make a plan','create a plan','build a plan',
    'help me prepare','help me study','how should i prepare',
    'prepare for','i want to prepare','i need to prepare',
    // New goal
    'want to learn','want to start','how do i start','where do i begin',
    'i want to become','planning to learn','want to become',
    // Stuck
    'feeling stuck','dont know what to do','no direction',
    'confused about career','what should i do with',
    // Startup
    'started a startup','have an idea','building a product','launching soon',
    // Job
    'got a job offer','job offer','should i join','negotiating salary'
  ];

  let socraticMode = socraticTriggers.some(t => msg.includes(t));

  // Keep socratic mode going until we have enough context
  // Check if the ORIGINAL situation trigger appeared in recent history
  const situationInHistory = history.slice(-6).some(m =>
    socraticTriggers.some(t => (m.content || '').toLowerCase().includes(t))
  );

  // Check if we have gathered enough answers (3+ student replies after trigger)
  const studentRepliesAfterTrigger = history.slice(-6).filter(m => m.role === 'user').length;
  const hasEnoughContext = studentRepliesAfterTrigger >= 3;

  // Trigger socratic if: situation detected NOW, or situation was recent and not enough context yet
  if (socraticMode || (situationInHistory && !hasEnoughContext)) {
    mode = 'socratic_intake';
  }

  console.log('[BRAIN] Agent decision:', { mode, subject, tools, socraticMode, signals: Object.keys(signals).filter(k => signals[k]) });

  return {
    // Core flags
    needsKnowledge:  tools.includes('knowledge_base'),
    needsWebSearch:  tools.includes('web_search'),
    needsEmotionalFirst,
    needsWebAndTeach,
    isExamPanic,
    isAnswerAttempt,

    // Mode
    mode,
    content_type: mode === 'flashcards' ? 'flashcards' : mode === 'practice' ? 'practice' : 'teaching',

    // Subject
    subject,

    // Tools to run
    tools,

    // Legacy flags
    wantsFlashcards: signals.wantsFlashcards,
    wantsPractice:   signals.wantsPractice,
    isEmotional:     signals.needsSupport
  };
}

// -------------------------------------------------------------
// SEARCH PINECONE FOR RIGHT CONTENT
// -------------------------------------------------------------
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
      visual:   'Visual learner - loves diagrams and pictures',
      hands_on: 'Hands-on learner - needs experiments and real activities',
      story:    'Story learner - connects through narratives and history',
      logical:  'Logical learner - wants proofs and step-by-step reasoning'
    }[learning_style] || 'Visual learner';

    return `STUDENT'S LEARNING STYLE: ${styleLabel}

RETRIEVED KNOWLEDGE (use this content - deliver in their learning style):
${ranked.map((h, i) => `[${i+1}] ${h.fields?.topic || ''} (${h.fields?.content_type || ''})\n${h.fields?.text || h.fields?.chunk_text || h.metadata?.text || ''}`).join('\n\n---\n\n')}`;

  } catch (err) {
    console.warn('Pinecone search failed:', err.message);
    return '';
  }
}



// -------------------------------------------------------------
// AUTO EMOTION DETECTOR
// Reads tone, words, punctuation - no AI call needed
// -------------------------------------------------------------
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
    frustrated:   { tone: 'empathetic and patient',  specialInstruction: 'Acknowledge their struggle first. Then try a COMPLETELY different angle - new analogy, new example.' },
    confused:     { tone: 'gentle and clear',         specialInstruction: 'Go back to absolute basics. One concept at a time. Smaller steps. Simpler language.' },
    anxious:      { tone: 'warm and reassuring',      specialInstruction: 'Address the anxiety in first 2 sentences before any content. Normalise the feeling.' },
    demotivated:  { tone: 'energising',               specialInstruction: 'Connect this topic to their actual goal first. Make it relevant before explaining.' },
    excited:      { tone: 'energetic and expansive',  specialInstruction: 'Match their energy! Then take them one level deeper than they expected.' },
    confident:    { tone: 'peer-level',               specialInstruction: 'Validate quickly then raise the bar: "Great - now try this harder version..."' },
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

// -------------------------------------------------------------
// SEARCH WEB VIA TAVILY
// Called for current affairs, news, exam notifications etc.
// -------------------------------------------------------------
async function searchWeb(query) {
  try {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    console.log('[KEY] TAVILY_API_KEY exists:', !!TAVILY_API_KEY);
    if (!TAVILY_API_KEY) return '';

    // Always inject current date into search - solid time compass
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.toLocaleString('en-US', { month: 'long' });
    const day   = now.getDate();
    const dateStr = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    // Resolve relative time words into absolute dates before searching
    let resolvedQuery = query
      .replace(/\btoday\b/gi,     `${month} ${day} ${year}`)
      .replace(/\byesterday\b/gi, (() => { const d = new Date(now); d.setDate(day-1); return d.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}); })())
      .replace(/\bthis year\b/gi, year.toString())
      .replace(/\blast year\b/gi, (year-1).toString())
      .replace(/\bthis week\b/gi, `week of ${month} ${year}`)
      .replace(/\blast month\b/gi, (() => { const d = new Date(now); d.setMonth(d.getMonth()-1); return d.toLocaleString('en-US',{month:'long',year:'numeric'}); })());

    // Always append year to anchor results - prevents returning old data
    // But if query already has a year (e.g. last year = 2025), don't append current year
    const hasAnyYear = /20[0-9]{2}/.test(resolvedQuery);
    const enrichedQuery = hasAnyYear
      ? resolvedQuery
      : `${resolvedQuery} ${year}`;

    console.log('[SEARCH] Tavily query:', enrichedQuery);

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: enrichedQuery,
        search_depth: 'advanced',  // deeper crawl for accuracy
        max_results: 5,
        include_answer: true,
        topic: 'news'  // prioritise fresh news with date metadata
      })
    });

    const data = await res.json();
    if (!res.ok || !data.results) return '';

    const results = data.results || [];

    // Filter out results that reference wrong years
    const currentYear = year.toString();
    const freshResults = results.filter(r => {
      const text = (r.title + r.content).toLowerCase();
      // Keep if it has current year OR no year reference
      return text.includes(currentYear) || !/(202[0-9])/.test(text) || true;
    });

    let context = `TODAY'S DATE: ${dateStr}
LIVE WEB SEARCH RESULTS for: "${query}"

`;

    if (data.answer) {
      context += `DIRECT ANSWER: ${data.answer}

`;
    }

    context += `SOURCES (prioritise results mentioning ${year}):
`;
    (freshResults.length > 0 ? freshResults : results).slice(0, 4).forEach((r, i) => {
      const publishedDate = r.published_date ? ` [Published: ${r.published_date}]` : '';
      context += `[${i+1}] ${r.title}${publishedDate}\n${(r.content || '').slice(0, 500)}\nURL: ${r.url}\n\n`;
    });

    return context;

  } catch (err) {
    console.warn('Web search failed (non-critical):', err.message);
    return '';
  }
}

// -------------------------------------------------------------
// BUILD THE COMPLETE TEACHING PROMPT
// This is the heart of MentorAI
// -------------------------------------------------------------
function buildTeachingPrompt(baseSystem, student, ragContext, intent, webContext = '') {

  const styleInstructions = {
    visual: `TEACHING STYLE - VISUAL LEARNER:
* Start by painting a clear mental image: "Picture this..." or "Imagine you can see..."
* Use diagrams described in words: arrows, boxes, relationships
* Use tables to compare concepts side by side
* Make the invisible visible - describe what things LOOK like`,

    hands_on: `TEACHING STYLE - HANDS-ON LEARNER:
* Start with something they can DO right now: "Try this...", "Do this experiment..."
* Give the experience FIRST - concept explanation comes AFTER they feel it
* Connect every abstract idea to something physical, touchable, testable
* Examples: coins, everyday objects, their own body, things at home`,

    story: `TEACHING STYLE - STORY LEARNER:
* Start with a story, real person, or historical moment - ALWAYS
* "In 1687, Newton was sitting..." / "Imagine you are a merchant in Venice..."
* Make them FEEL part of the narrative before introducing the concept
* Science and math happen to PEOPLE in PLACES - make it human`,

    logical: `TEACHING STYLE - LOGICAL LEARNER:
* Start with a clean definition or first principle
* Show every derivation step - no skipping, no hand-waving
* Use: "Let's prove this formally..." / "From first principles..."
* Connect to mathematical structures, exceptions, and deeper implications`
  };

  const emotionGuides = {
    stressed:   'Student is STRESSED. Acknowledge briefly. Keep explanation short. Break into tiny steps. Extra encouragement.',
    anxious:    'Student is ANXIOUS. Be very gentle. Go slowly. Celebrate every small understanding.',
    frustrated: 'Student is FRUSTRATED. Acknowledge the difficulty. Try a COMPLETELY fresh angle - not same explanation again.',
    confused:   'Student is CONFUSED. Start from absolute basics. Assume zero prior knowledge. Build slowly.',
    curious:    'Student is CURIOUS - best state! Go deeper. Add fascinating connections. Make it exciting.',
    excited:    'Student is EXCITED! Match energy. Keep it dynamic. Move fast but thoroughly.',
    neutral:    'Normal engagement. Warm, clear, conversational.'
  };

  const deliveryFormats = {
    flashcards: `DELIVERY: Flashcard mode.
Format each card as:
? Q: [question]
[OK] A: [answer]
Give 5 flashcards. After all 5 ask: "Want 5 more or shall we practice with questions?"`,

    practice: `DELIVERY: Practice mode.
1. Give ONE practice problem at their level
2. Let them attempt (end with "Try it - what do you get?")
3. After they respond, walk through full solution step by step
4. End with one slightly harder follow-up`,

    teaching: `DELIVERY: Teaching mode.
1. HOOK (1-2 sentences in their learning style - grab attention)
2. CORE CONCEPT (explained in their style - not textbook language)
3. REAL WORLD CONNECTION (something they can relate to personally)
4. CHECK IN: End with "Does that click? Or should we try a different angle?"`,

    emotional_support: `DELIVERY: Emotional support mode.
1. ACKNOWLEDGE - reflect back exactly what they said they're feeling
2. NORMALISE - tell them this is common, they're not alone
3. REFRAME - one perspective shift
4. GENTLE NEXT STEP - one tiny action they can take right now
Never jump to solutions before they feel heard.`,

    exam_panic: `DELIVERY: Exam panic mode. TIME IS CRITICAL.
1. ONE calm sentence: acknowledge the pressure
2. "Here's your game plan for the next [X] hours:"
3. Top 5 most important topics ONLY - no more
4. For each topic: ONE key formula/concept in one line
5. End with: "You've got this. Focus beats panic every time."
Keep entire response under 200 words. No deep explanations.`,

    summary: `DELIVERY: Summary mode.
Give a clean, scannable summary:
[PIN] KEY POINTS (3-5 bullets max)
[TARGET] CORE IDEA (one sentence)
[IDEA] REMEMBER THIS (one memorable hook)`,

    study_plan: `DELIVERY: Study plan mode.
Build a realistic plan:
[CAL] TIMELINE: [based on their exam/goal]
[BOOK] WEEK BY WEEK breakdown
? DAILY time commitment (be realistic, not aspirational)
[OK] MILESTONES to track progress
Start by asking: what's your exam date and daily available hours?`,

    comparison: `DELIVERY: Comparison mode.
Use a clear table or parallel structure:
[CONCEPT A] vs [CONCEPT B]
- Key difference 1
- Key difference 2  
- When to use which
End with a memory trick to never confuse them again.`,

    check_answer: `DELIVERY: Answer check mode.
1. Confirm if their answer is correct or not - directly
2. If wrong: show exactly where they went wrong (not just the right answer)
3. Walk through the correct method step by step
4. Give one more similar problem to solidify`,

    conversation: `DELIVERY: Conversational mode.
Respond naturally and warmly. No teaching structure needed.
Keep it brief and human. Ask what they want to work on next.`,

    socratic_intake: `DELIVERY: Socratic Intake mode.
The student shared a HIGH-STAKES situation. Do NOT jump to advice yet.
Diagnose before you prescribe - like a smart mentor would.

RULES:
1. Acknowledge their situation in ONE warm sentence - genuine, not generic
2. Ask ONLY 1 question - the single most important one right now
3. Occasionally 2 if they are very short and flow as one natural thought
4. NEVER ask 3 or more questions - ever. It feels like a job application form.
5. After they answer - ask the NEXT most important question if still needed
6. Once you have enough context - stop asking and help fully

HOW TO PICK THE ONE RIGHT QUESTION:
- Interview -> "What company is it for?" - everything else flows from that
- Exam -> "Which subject is worrying you most?"
- Presentation -> "Who is the audience?"
- Want to learn -> "What is driving this - a specific job goal or general curiosity?"
- Stuck/lost -> "What area feels most unclear right now - career, studies, or something personal?"
- Startup idea -> "Tell me the idea in one line"
- Job offer -> "What are the two options you are choosing between?"

TONE: Like a smart friend who genuinely wants to understand - not a chatbot running a script.

GOOD EXAMPLE:
Student: "I have a Python interview tomorrow"
You: "Nice - which company is it for?"
[Wait. Then next question based on their answer.]

BAD EXAMPLE - NEVER do this:
"What company, what role, what topics are covered, how many hours do you have, and what is your current Python level?"
That is an interrogation. Not mentoring.`
  };

  const deliveryFormat = deliveryFormats[intent.mode] || deliveryFormats[intent.content_type] || deliveryFormats.teaching;
  const styleGuide     = styleInstructions[student.learning_style] || styleInstructions.visual;
  const emotionGuide   = emotionGuides[student.emotion?.toLowerCase()] || emotionGuides.neutral;
  const specialInstruction = student.emotionAdjustments?.specialInstruction || '';

  let prompt = `${baseSystem}

========================================
STUDENT PROFILE - READ THIS FIRST
========================================
Name: ${student.name}
Learning Style: ${student.learning_style.toUpperCase()} <- MOST IMPORTANT
Personality: ${student.personality}
Level: ${student.level}
Target Exam: ${student.exam_target}
Emotion Right Now: ${student.emotion}
Weak Areas: ${student.weak_subjects.join(', ') || 'None specified'}

========================================
EMOTION GUIDANCE
========================================
${emotionGuide}

========================================
${styleGuide}

========================================
${deliveryFormat}
========================================

========================================
COMMUNICATION STYLE - NON-NEGOTIABLE
========================================
You communicate like the world's top 1% professionals.
Your style is modelled after:
- Clarity of Richard Feynman - explain complex things simply, never talk down
- Precision of a Harvard professor - every word is chosen deliberately
- Warmth of a seasoned mentor - you care, and it shows naturally
- Confidence of a Fortune 500 CEO - direct, no hedging, no fluff

HARD RULES ON LANGUAGE:
- NEVER use: "certainly", "absolutely", "great question", "of course", "sure thing", "happy to help", "definitely", "fantastic"
- NEVER start a response with a compliment about the question
- Speak with authority but stay human and approachable
- Use real-world analogies to explain abstract concepts
- Every sentence must add value - if it doesn't, cut it
- Structure: context -> insight -> action (when giving advice)
- In conversation: be brief, warm, direct - like a trusted friend who happens to be an expert

NON-NEGOTIABLE RULES:
1. NEVER start with a textbook definition
2. ALWAYS start with their learning style hook
3. Use ${student.name}'s name at least once naturally
4. If confused - try a DIFFERENT angle, not the same explanation
5. You are their personal mentor - warm, patient, specific to THEM
6. Keep responses focused - do not overwhelm with too much at once
7. NEVER say "I don't have access to real-time data" or "my training cutoff" - you have live web search. USE IT.
8. If web search results are provided below - USE THEM to answer. Always.

CONVERSATION vs CONTENT - CRITICAL DISTINCTION:
When the student sends a SHORT conversational message (under 15 words, no explicit request for a list or explanation):
-> NEVER dump bullets, steps, lists, or full plans
-> Respond conversationally - 2-3 lines MAX
-> Ask ONE follow-up question or make ONE observation
-> Think: "What would a smart friend say?" not "What would a textbook say?"

When the student EXPLICITLY asks for content (e.g. "give me 100 questions", "explain", "list all topics", "make a plan"):
-> THEN give the full structured response

SIMPLE TEST before every response:
Did they ask for information? -> Give information.
Did they share a situation? -> Ask about it first. Help second.
Are they in a conversation? -> Stay in the conversation. Do not lecture.`;

  if (ragContext) {
    prompt += `

========================================
KNOWLEDGE BASE - YOUR TEACHING MATERIAL
========================================
${ragContext}

[WARN]? USE the knowledge above as your source.
[WARN]? TRANSFORM it into ${student.name}'s learning style - do NOT copy verbatim.
[WARN]? Deliver it the way a ${student.learning_style} learner needs it.`;
  }

  // Socratic intake - OVERRIDE everything with a simple, laser-focused prompt
  if (intent._socraticInstruction) {
    return `You are ${student.name}'s personal mentor. You are in the middle of understanding their situation before giving advice.

Your ONLY task right now: Ask this one question naturally - "${intent._socraticInstruction}"

Rules:
- ONE sentence acknowledging what they said (optional, only if natural)
- Then ask the question - warm, direct, like a friend
- STOP. Nothing else.
- No bullet points. No tips. No preparation advice. No lists.
- Maximum 2 sentences total.`;
  }

  // Inject emotion-based instruction if detected with confidence
  if (specialInstruction) {
    prompt += `

========================================
EMOTION DETECTED: ${student.emotion.toUpperCase()}
========================================
PRIORITY INSTRUCTION FOR THIS RESPONSE: ${specialInstruction}
This overrides your default response style for this one message.`;
  }

  return prompt;
}

// -------------------------------------------------------------
// AI MODEL CALLS
// -------------------------------------------------------------
async function callAI(model, messages, system) {
  if (model === 'claude') return callClaude(messages, system);
  if (model === 'gemini') return callGemini(messages, system);
  return callOpenAI(messages, system, 'gpt-4o');
}

async function callOpenAI(messages, system, modelName = 'gpt-4o') {
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
