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
    const userId         = body.user_id  || null;
    const userEmail      = body.user_email || studentProfile.email || null;
    const quizState      = body.quiz_state || null; // tracks current quiz progress

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
    let ragNoContent = false;
    if (intent.needsKnowledge) {

      // Pass mode + recentHistory so RAG can:
      // - rewrite vague queries ("explain it again") into clean search terms
      // - use dynamic top_k suited to the student's emotional state/mode
      // - filter by subject if detected
      const ragResult = await searchKnowledge(
        userMessage,
        student.learning_style,
        intent.subject,
        intent.content_type,
        intent.mode,
        messages.slice(-4)
      );
      ragContext   = ragResult.context;
      ragNoContent = ragResult.noRelevantContent;

      // Hallucination guard: log when AI will answer with no RAG backing
      if (ragNoContent) {
        console.warn('[HALLUCINATION_GUARD] No relevant content found in knowledge base — AI will use general knowledge for:', userMessage.slice(0, 100));
      }
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

IMPORTANT: End your response with exactly this line on its own:
"Note: This is based on the latest available information. For live updates check Cricinfo / NSE / Google News directly."`;
        } else {
          webContext += `

IMPORTANT: End your response with exactly this line on its own:
"Note: Based on latest available information. Verify from primary sources for critical decisions."`;
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

    // ── Quiz Interceptor ──────────────────────────────────────
    // If user asks for N questions, intercept and enforce ONE at a time
    const quizMatch = userMessage.match(/quiz.*?(\d+)\s*question/i) ||
                      userMessage.match(/(\d+)\s*question.*quiz/i) ||
                      userMessage.match(/give.*?(\d+)\s*question/i);
    if (quizMatch && intent.mode === 'practice') {
      const totalQ = parseInt(quizMatch[1]);
      const currentQ = quizState ? quizState.current : 1;
      intent._quizInstruction = `
You are in a quiz session. Total questions: ${totalQ}. Current question: ${currentQ} of ${totalQ}.
GIVE ONLY QUESTION ${currentQ}. ONE QUESTION ONLY.
Format: "Question ${currentQ} of ${totalQ} — [Topic]\n[Question]\n\nWhat is your answer?"
DO NOT give question ${currentQ + 1} or any other question.
DO NOT reveal the answer.
STOP after the question.`;
    }
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
    const systemPrompt = buildTeachingPrompt(baseSystemWithDate, student, ragContext, intent, webContext, ragNoContent);

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

    // Step 6: Smart model routing + rate limiting
    const _responseStart = Date.now();

    // Check how many premium messages used today
    const premiumUsedToday = await countPremiumMessagesToday(
      body.user_id || null,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const DAILY_PREMIUM_LIMIT = 20;
    const premiumAllowed = premiumUsedToday < DAILY_PREMIUM_LIMIT;

    // Route to best model based on message + context
    const routing = selectBestModel(userMessage, intent, emotionData, webContext, premiumAllowed);
    const smartModel = routing.model;
    const isPremium  = routing.isPremium;

    console.log(`[ROUTING] model=${smartModel} | premium=${isPremium} | used=${premiumUsedToday}/${DAILY_PREMIUM_LIMIT} | reason=${routing.reason}`);

    const response = await callAI(smartModel, finalMessages, systemPrompt);
    const _responseTimeMs = Date.now() - _responseStart;

    // Detect issues for prompt analysis — saved to chat_messages.issue column
    const issues = [];
    if (ragNoContent)                              issues.push('No RAG content');
    if (!ragNoContent && !ragContext)              issues.push('No RAG content');
    if ((response.content || '').length < 100)    issues.push('Short AI response');
    const confusedSignals = ['again','dont understand',"don't understand",'explain again','still confused','not clear'];
    if (confusedSignals.some(k => userMessage.toLowerCase().includes(k))) issues.push('Student confused');
    const negativeEmotions = ['panicked','frustrated','anxious','stressed'];
    if (negativeEmotions.includes(emotionData.emotion)) issues.push(`Negative emotion: ${emotionData.emotion}`);

    // ── Daily Pattern Recognition ────────────────────────────
    const psychDiscovery = detectPsychInsight(userMessage, messages.slice(-6), emotionData);

    // Calculate cost
    const MODEL_PRICING = {
      'gpt-4o':                   { input: 2.50,   output: 10.00  },
      'gpt-4o-mini':              { input: 0.15,   output: 0.60   },
      'claude-sonnet-4-6':        { input: 3.00,   output: 15.00  },
      'claude-3-5-haiku-20241022':{ input: 0.80,   output: 4.00   },
      'gemini-1.5-flash':         { input: 0.075,  output: 0.30   },
      'llama-3.3-70b-versatile':  { input: 0.05,   output: 0.10   },
      'deepseek-chat':            { input: 0.014,  output: 0.028  }
    };
    const usage    = response.usage || {};
    const pricing  = MODEL_PRICING[smartModel] || MODEL_PRICING['gpt-4o'];
    const promptTokens     = usage.prompt_tokens     || usage.input_tokens  || 0;
    const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
    const totalTokens      = usage.total_tokens || (promptTokens + completionTokens);
    const costUSD = (
      (promptTokens     / 1_000_000) * pricing.input +
      (completionTokens / 1_000_000) * pricing.output
    );

    // Add metadata for frontend to save to Supabase
    response.meta = {
      emotion:           emotionData.detected ? emotionData.emotion : student.emotion || 'neutral',
      rag_hit:           !ragNoContent && !!ragContext,
      rag_score:         null,
      mode:              intent.mode    || 'teaching',
      subject:           intent.subject || null,
      issue:             issues.length > 0 ? issues.join(' | ') : null,
      psych_insight:     psychDiscovery.insight || null,
      psych_key:         psychDiscovery.key     || null,
      // Model routing
      rating:            0,
      session_id:        null,
      response_time_ms:  _responseTimeMs,
      model_used:        smartModel,
      is_premium:        isPremium,
      routing_reason:    routing.reason,
      premium_used_today: premiumUsedToday,
      web_search_used:   !!webContext,
      rag_score_actual:  null,
      tokens_prompt:     promptTokens     || null,
      tokens_completion: completionTokens || null,
      tokens_total:      totalTokens      || null,
      cost_usd:          parseFloat(costUSD.toFixed(6)) || null
    };

    // ── Proactive Mentor System ──────────────────────────────
    // Detect trigger SYNCHRONOUSLY (fast — no API calls)
    // Then return response immediately and trigger email in background
    const proactiveTrigger = detectProactiveTrigger(userMessage, messages, response.meta);
    if (proactiveTrigger && userId && userEmail) {
      response.meta.proactive_action = 'schedule_created';
      response.meta.proactive_goal   = proactiveTrigger.goal;
      response.meta.proactive_topic  = proactiveTrigger.topic;
    }

    // Return response to user IMMEDIATELY — no waiting
    res.status(200).json(response);

    // AFTER response sent — trigger emails in background (non-blocking)
    if (proactiveTrigger && userId && userEmail) {
      triggerProactiveMentor({
        userId,
        userEmail,
        userName:      student.name,
        learningStyle: student.learning_style,
        personality:   student.personality,
        trigger:       proactiveTrigger,
        supabaseUrl:   process.env.SUPABASE_URL,
        supabaseKey:   process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
        baseUrl:       'https://mentor-ai-swart.vercel.app'
      }).catch(e => console.warn('[PROACTIVE] Background error:', e.message));
    }

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
    name:              profile.name             || 'Student',
    learning_style:    (function() {
      const raw = profile.learning_style || profile.learn_style || '';
      const map = {
        'visual':'visual','diagram':'visual','chart':'visual',
        'hands_on':'hands_on','hands-on':'hands_on','doing':'hands_on','project':'hands_on','building':'hands_on','practical':'hands_on',
        'story':'story','narrative':'story','example':'story',
        'logical':'logical','analytical':'logical','data':'logical'
      };
      const key = Object.keys(map).find(k => raw.toLowerCase().includes(k));
      return key ? map[key] : (personalityToStyle[profile.personality_type] || 'visual');
    })(),
    personality:       profile.personality_type || 'The Grower',
    personality_desc:  profile.personality_desc || '',
    persona:           profile.persona          || 'friend',
    mbti_type:         profile.mbti_type        || null,
    primary_interest:  profile.primary_interest || null,
    eq_strength:       profile.eq_strength      || null,
    motivators:        profile.motivators       || [],
    traits:            profile.traits           || {},
    level:             profile.academic_level   || 'Student',
    exam_target:       profile.exam_target      || profile.goal || 'their goal',
    timeline:          profile.timeline         || null,
    emotion:           profile.current_emotion  || 'neutral',
    weak_subjects:     profile.weak_subjects    || [],
    strong_subjects:   profile.strong_subjects  || [],
    memory:            profile.memory           || null
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
      // NOTE: Do NOT add generic time words here — they cause false positives
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
  // Override web search if user is clearly in study/exam context
  // Prevents "I prepared 7 years ago" from triggering news search
  const isStudyContext = signals.wantsPractice || signals.wantsFlashcards ||
    signals.wantsExplanation || signals.wantsSummary || signals.wantsStudyPlan ||
    (subject !== null);
  if (isStudyContext && signals.needsWebSearch) {
    // Only keep web search if message has clear current-events signal
    const hasCurrentEventsSignal = ['news','today','latest','current','2025','2026',
      'announced','launched','just released','this week'].some(k => msg.includes(k));
    if (!hasCurrentEventsSignal) {
      signals.needsWebSearch = false;
    }
  }

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
// Now calls the production RAG endpoint which handles:
// - query rewriting for vague messages
// - score threshold filtering
// - dynamic top_k by mode
// - retry logic on Pinecone timeouts
// - context window budget
// Returns { context, noRelevantContent } instead of raw string
// so chat.js can handle the "no results" case without hallucinating
// -------------------------------------------------------------
async function searchKnowledge(query, learning_style, subject, content_type, mode, recentHistory = []) {
  try {
    const { PINECONE_API_KEY, PINECONE_HOST, OPENAI_API_KEY } = process.env;

    if (!PINECONE_API_KEY || !PINECONE_HOST) {
      console.warn('[RAG] Pinecone env vars missing — skipping knowledge search');
      return { context: '', noRelevantContent: true };
    }

    // ── Query Rewriting ──────────────────────────────────────
    // Rewrites vague follow-ups ("explain it again", "I don't get it")
    // into clean search queries before hitting Pinecone
    const cleanQuery = await rewriteQuery(query, recentHistory, OPENAI_API_KEY);
    console.log(`[RAG] Query: "${query}" → "${cleanQuery}"`);

    // ── Dynamic top_k by mode ────────────────────────────────
    const topK = getTopK(mode);

    // ── Embed with correct dimensions for your 1024-dim index ──
    const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        input:      cleanQuery,
        model:      'text-embedding-3-small',
        dimensions: 1024   // Critical: must match your Pinecone index dimensions
      })
    });

    const embedData = await embedRes.json();
    if (!embedData.data) {
      console.error('[RAG] Embedding failed:', embedData.error?.message || 'unknown');
      return { context: '', noRelevantContent: true };
    }
    const vector = embedData.data[0].embedding;

    // ── Pinecone search with subject filter + retry ───────────
    let pineconeData = await queryPinecone(PINECONE_HOST, PINECONE_API_KEY, vector, topK, subject);

    // Single retry on failure (handles transient timeouts)
    if (!pineconeData) {
      console.warn('[RAG] Retrying Pinecone after 500ms...');
      await new Promise(r => setTimeout(r, 500));
      pineconeData = await queryPinecone(PINECONE_HOST, PINECONE_API_KEY, vector, topK, subject);
    }

    if (!pineconeData) {
      console.error('[RAG] Pinecone unavailable after retry');
      return { context: '', noRelevantContent: true };
    }

    const allHits = pineconeData.matches || [];

    // ── Score threshold filtering ─────────────────────────────
    // Chunks below MIN_SCORE are noise — don't send to AI
    const MIN_SCORE = 0.55;
    const hits = allHits.filter(h => (h.score || 0) >= MIN_SCORE);
    const topScore = allHits[0]?.score || 0;

    console.log(`[RAG] ${allHits.length} raw hits | ${hits.length} passed score ${MIN_SCORE} | top: ${topScore.toFixed(3)}`);
    console.log('[PINECONE RAW HITS]', JSON.stringify(allHits.map(h => ({ score: h.score, meta: h.metadata })), null, 2));

    // ── noRelevantContent signal ──────────────────────────────
    // Explicit flag so caller knows to use general knowledge
    // instead of letting AI silently hallucinate specifics
    if (hits.length === 0) {
      console.log('[RAG] No chunks passed threshold — noRelevantContent = true');
      return { context: '', noRelevantContent: true, topScore };
    }

    // ── Build context with hard character budget ─────────────
    // Prevents silent prompt overflow that truncates AI responses
    const MAX_CONTEXT_CHARS = 3000; // ~750 tokens — safe within max_tokens:1200
    let context = '';
    let usedChunks = 0;

    for (let i = 0; i < hits.length; i++) {
      const m    = hits[i].metadata || {};
      const text = m.text || m.chunk_text || m.page_content || m.content || '';
      if (!text) continue;

      const chunk = `[Source ${i + 1}]: ${text}`;
      if ((context + chunk).length > MAX_CONTEXT_CHARS) {
        console.log(`[RAG] Context budget reached at chunk ${i + 1}`);
        break;
      }
      context += chunk + '\n\n';
      usedChunks++;
    }

    console.log(`[RAG CONTEXT] ${usedChunks} chunks used, ${context.length} chars`);

    if (!context) {
      return { context: '', noRelevantContent: true };
    }

    return {
      context: `KNOWLEDGE BASE DATA:\n${context}`,
      noRelevantContent: false,
      topScore
    };

  } catch (err) {
    console.error('[RAG] searchKnowledge error:', err.message);
    return { context: '', noRelevantContent: true };
  }
}

// ─────────────────────────────────────────────────────────────
// QUERY REWRITER (inline in chat.js — no extra API route needed)
// Uses GPT-4o-mini to clean up vague student messages
// Falls back to original query silently on any failure
// ─────────────────────────────────────────────────────────────
async function rewriteQuery(query, recentHistory = [], openAiKey) {
  // Skip rewrite for clear, specific queries — saves cost + latency
  const isAlreadyClear = query.length > 15 &&
    !/(it|this|that|again|re-?explain|don.?t get|what do you mean|huh|still|same thing)/i.test(query);

  if (isAlreadyClear || !openAiKey) return query;

  try {
    const historySnippet = recentHistory
      .slice(-3)
      .map(m => `${m.role === 'user' ? 'Student' : 'Mentor'}: ${(m.content || '').slice(0, 150)}`)
      .join('\n');

    const prompt = `You are rewriting a student's vague message into a clean knowledge-base search query.

Recent conversation:
${historySnippet || '(no history)'}

Student's message: "${query}"

Write ONE short search query (5-12 words) capturing what concept they need explained.
Return ONLY the query. No punctuation, no explanation, no quotes.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiKey}` },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  40,
        temperature: 0.1
      })
    });

    const data = await res.json();
    const rewritten = data?.choices?.[0]?.message?.content?.trim();
    return (rewritten && rewritten.length > 3) ? rewritten : query;

  } catch (err) {
    console.warn('[RAG] Query rewrite failed (non-critical):', err.message);
    return query;
  }
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC top_k
// Fewer chunks for panicked/tired students, more for deep modes
// ─────────────────────────────────────────────────────────────
function getTopK(mode) {
  const map = {
    exam_panic:  2,
    tired:       2,
    flashcards:  3,
    summary:     4,
    teaching:    5,
    practice:    5,
    comparison:  8,
    study_plan:  6
  };
  return map[mode] || 5;
}

// ─────────────────────────────────────────────────────────────
// PINECONE QUERY (isolated for clean retry)
// ─────────────────────────────────────────────────────────────
async function queryPinecone(host, apiKey, vector, topK, subject) {
  try {
    // Add subject filter if we know the subject and metadata was stored at ingest
    const filter = subject ? { subject: { '$eq': subject } } : undefined;

    const res = await fetch(`${host}/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': apiKey },
      body: JSON.stringify({
        vector,
        topK,
        includeMetadata: true,
        namespace: '',
        ...(filter && { filter })
      })
    });

    if (!res.ok) {
      console.error(`[RAG] Pinecone HTTP ${res.status}:`, await res.text());
      return null;
    }

    return await res.json();

  } catch (err) {
    console.error('[RAG] queryPinecone fetch error:', err.message);
    return null;
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
// BUILD THE ARIA PROMPT
// Short. Sharp. Works for every user, every topic.
// Two sources: psychometric profile + live observation.
// Four behaviors: drill down, sprint, re-engage, personalise.
// -------------------------------------------------------------
function buildTeachingPrompt(baseSystem, student, ragContext, intent, webContext = '', ragNoContent = false) {

  // -- Quiz interceptor — code enforces one question at a time --
  if (intent._quizInstruction) {
    return 'You are ' + student.name + '\'s personal mentor running a quiz.\n\n'
      + intent._quizInstruction + '\n\n'
      + 'Learning style: ' + (student.learning_style || 'visual') + '\n'
      + 'Topic: ' + (intent.subject || 'the requested subject') + '\n\n'
      + 'RULE: Give exactly ONE question. Wait for their answer. Nothing else.';
  }

  // -- Socratic intake — code asks one focused question ----------
  if (intent._socraticInstruction) {
    return 'You are ' + student.name + '\'s personal mentor.\n'
      + 'Ask this one question naturally: "' + intent._socraticInstruction + '"\n'
      + 'One warm sentence first if natural. Then the question. Stop. Maximum 2 sentences.';
  }

  // -- Build variables cleanly — no nested template literals ----
  const name        = student.name || 'there';
  const learnStyle  = student.learning_style || 'visual';
  const persona     = student.persona || 'friend';
  const goal        = student.exam_target || 'their goal';
  const weakAreas   = (student.weak_subjects || []).join(', ') || 'not identified yet';
  const strongAreas = (student.strong_subjects || []).join(', ') || 'not identified yet';
  const motivators  = (student.motivators || []).join(', ') || 'growth and achievement';
  const emotion     = (student.emotion || 'neutral').toLowerCase();

  const styleHow = {
    hands_on: 'Give them something to DO first. Experience before theory. Start with an action, not a definition.',
    story:    'Start with a real person or real moment. Make them feel it before explaining it.',
    logical:  'Start with first principles. Show every step. No skipping.',
    visual:   'Paint a mental image first. Make the invisible visible before the concept.'
  }[learnStyle] || 'Adapt to how they write.';

  const emotionNote = {
    panicked:     'PANICKED: One calm sentence first. Then top 5 key points only. Under 150 words.',
    frustrated:   'FRUSTRATED: Acknowledge the struggle first. Try a completely different angle.',
    confused:     'CONFUSED: Go back to basics. One concept. Smaller steps.',
    anxious:      'ANXIOUS: Address the anxiety in first sentence. Normalise it. Then content.',
    demotivated:  'DEMOTIVATED: Connect to their goal first. Make it relevant before explaining.',
    excited:      'EXCITED: Match their energy. Go deeper than they expected.',
    tired:        'TIRED: Short response. Gentle tone. End with a rest suggestion.'
  }[emotion] || '';

  const lastTopic   = student.memory && student.memory.last_topic ? student.memory.last_topic : '';
  const pendingItem = student.memory && student.memory.pending_followup ? student.memory.pending_followup : '';

  // -- THE ARIA PROMPT ------------------------------------------
  let prompt = baseSystem + '\n'

  + '========================================\n'
  + 'YOU ARE ARIA — PERSONAL MENTOR\n'
  + 'Not a chatbot. Not a search engine. A presence that knows this person.\n'
  + '========================================\n\n'

  + 'WHO YOU ARE TALKING TO\n'
  + '========================================\n'
  + 'SOURCE 1 — PSYCHOMETRIC PROFILE (who they are):\n'
  + 'Name: ' + name + '\n'
  + 'Personality: ' + (student.personality || 'not set') + (student.mbti_type ? ' (' + student.mbti_type + ')' : '') + '\n'
  + 'How they learn: ' + learnStyle + ' — ' + styleHow + '\n'
  + 'Persona chosen: ' + persona + '\n'
  + 'Motivators: ' + motivators + '\n'
  + 'EQ strength: ' + (student.eq_strength || 'not set') + '\n'
  + 'Goal: ' + goal + '\n'
  + 'Level: ' + (student.level || 'not set') + '\n'
  + 'Weak areas: ' + weakAreas + '\n'
  + 'Strong areas: ' + strongAreas + '\n\n'

  + 'SOURCE 2 — LIVE OBSERVATION (how they are right now):\n'
  + 'Read HOW they write in this conversation and adapt:\n'
  + '  Short blunt messages → be direct, no padding\n'
  + '  Long emotional messages → hear them first, content second\n'
  + '  One-word replies after being active → motivation dropping — re-engage NOW\n'
  + '  Excited energy → match it\n'
  + '  Informal → warm. Technical → precise.\n\n'

  + 'RULE: Profile tells you WHO they are. Live observation tells you HOW they are today.\n'
  + 'If profile says hands-on but today they write in panic → acknowledge panic first, then hands-on style.\n\n'

  + (lastTopic
    ? 'MEMORY: Last session covered "' + lastTopic + '". '
      + 'Start by referencing this: "Last time we covered ' + lastTopic + '. Want to continue or start something new?"\n'
      + (pendingItem ? 'Pending followup: ' + pendingItem + '\n' : '')
      + '\n'
    : 'MEMORY: First session. Start fresh.\n\n')

  + '========================================\n'
  + 'HOW ARIA THINKS — 4 BEHAVIORS, EVERY SESSION\n'
  + '========================================\n\n'

  + '1. FEEL FIRST\n'
  + 'Read the emotion. If they are stressed, lost, or overwhelmed — acknowledge in ONE sentence before anything else.\n'
  + 'Never skip this. An answer given to an unheard person is wasted.\n\n'

  + '2. DRILL DOWN BEFORE ANSWERING\n'
  + 'Never answer a vague message. Ask ONE question at a time until you know:\n'
  + '  What exactly? → What kind of help? → How much time today?\n'
  + 'Only after all three — proceed to behavior 3.\n\n'
  + 'Examples:\n'
  + '"I want to study physics" → "Which topic?"\n'
  + '"Electromagnetism" → "Concept or applying it to problems?"\n'
  + '"Application" → "How much time today — 1 hour or 2?"\n'
  + '"I want to prepare for CAT" → "Which section is weakest — Quant, Verbal, or LRDI?"\n\n'

  + '3. OFFER A SPRINT PROACTIVELY\n'
  + 'Once you know what they need and how much time — offer a sprint without being asked.\n'
  + '1 hour → one sprint: one concept + problems one at a time.\n'
  + '2 hours → two options: Sprint A (focused) or Sprint B (deeper). Let them pick.\n'
  + 'Inside sprint: deliver content in their style (' + learnStyle + ' — ' + styleHow + ')\n'
  + 'Then problems ONE at a time. Wait for answer. Evaluate. Give next.\n'
  + 'Sprint done → score + one weak area named + tomorrow preview + celebrate:\n'
  + '"You just did more focused work than most people do all week."\n\n'

  + '4. NEVER GIVE A GENERIC ANSWER\n'
  + 'Before writing — ask yourself: could I send this to a different person?\n'
  + 'If YES — rewrite it. Must only make sense for ' + name + '.\n'
  + 'After 3-4 exchanges — reflect personality back:\n'
  + '"Based on how you write to me, I notice you don\'t waste words. Does that feel right?"\n\n'

  + 'MOTIVATION SIGNAL — watch for these:\n'
  + 'One-word replies, "ok", "fine", "maybe later", flat tone after being active.\n'
  + 'When detected → STOP content. Say: "Hey — still with me? You were doing well on this."\n'
  + 'Connect back to their motivator: ' + motivators + '\n'
  + 'Never guilt. Warm nudge only.\n\n'

  + '========================================\n'
  + 'WHAT ARIA NEVER DOES\n'
  + '========================================\n'
  + 'NEVER answers a vague message without drilling down first\n'
  + 'NEVER gives a plan or explanation that works for anyone else\n'
  + 'NEVER asks more than ONE question at a time\n'
  + 'NEVER dumps all problems or all content at once\n'
  + 'NEVER ignores a motivation signal\n'
  + 'NEVER waits to be asked before offering a sprint\n'
  + 'NEVER uses: certainly, absolutely, great question, happy to help\n'
  + 'NEVER starts with a compliment or textbook definition\n\n'

  + 'RESPONSE LENGTH\n'
  + 'Message under 10 words → reply under 40 words. No exceptions.\n'
  + 'Emotional message → acknowledge first, content second.\n'
  + 'Short in → short out. Match their energy always.\n';

  // -- Emotion priority override --------------------------------
  if (emotionNote) {
    prompt += '\nEMOTION: ' + emotion.toUpperCase() + ' — ' + emotionNote + '\n';
  }

  // -- RAG knowledge source ------------------------------------
  if (ragContext) {
    prompt += '\n========================================\n'
      + 'KNOWLEDGE SOURCE — use this as your source of truth.\n'
      + 'Transform into ' + name + '\'s ' + learnStyle + ' learning style. Never copy verbatim.\n'
      + 'Do not mention "database" or "Source 1" — present as your own knowledge.\n\n'
      + ragContext + '\n';
  } else if (ragNoContent) {
    prompt += '\nNo documents found. Answer from general knowledge. Do not invent specific facts.\n';
  }

  return prompt;
}


// -------------------------------------------------------------
// AI MODEL CALLS
// -------------------------------------------------------------
// ─────────────────────────────────────────────────────────────
// SMART MODEL ROUTER
// ─────────────────────────────────────────────────────────────

// Count today's premium messages for this user from Supabase
async function countPremiumMessagesToday(userId, supabaseUrl, supabaseKey) {
  if (!userId || !supabaseUrl || !supabaseKey) return 0;
  try {
    const todayIST = new Date();
    todayIST.setHours(0, 0, 0, 0);
    const startUTC = new Date(todayIST.getTime() - (5.5 * 60 * 60 * 1000)).toISOString();
    const url = `${supabaseUrl}/rest/v1/chat_messages?user_id=eq.${userId}&is_premium=eq.true&created_at=gte.${startUTC}&select=id`;
    const res = await fetch(url, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch(e) {
    console.warn('[RATE-LIMIT] Count failed (non-critical):', e.message);
    return 0;
  }
}

// Select best model based on message intent + premium availability
function selectBestModel(message, intent, emotionData, webContext, premiumAllowed) {
  const msg = message.toLowerCase();

  // ── PREMIUM ROUTING (when within 20/day limit) ─────────────
  if (premiumAllowed) {

    // Emotional support → Claude is best for empathy + nuance
    if (
      emotionData.detected &&
      ['panicked','frustrated','anxious','stressed','demotivated','tired'].includes(emotionData.emotion)
    ) {
      return { model: 'claude-sonnet-4-6', isPremium: true, reason: 'Emotional support → Claude' };
    }

    // Life advice, career guidance, deep personal questions → Claude
    if (intent.mode === 'emotional_support' || intent.mode === 'socratic_intake') {
      return { model: 'claude-sonnet-4-6', isPremium: true, reason: 'Life/career guidance → Claude' };
    }

    // Complex explanation, study plan, exam prep → GPT-4o
    if (
      intent.mode === 'teaching' ||
      intent.mode === 'study_plan' ||
      intent.mode === 'exam_panic' ||
      intent.mode === 'comparison' ||
      intent.needsKnowledge
    ) {
      return { model: 'gpt-4o', isPremium: true, reason: 'Deep teaching → GPT-4o' };
    }

    // Practice questions, check answer → GPT-4o
    if (intent.mode === 'practice' || intent.mode === 'check_answer') {
      return { model: 'gpt-4o', isPremium: true, reason: 'Practice/evaluation → GPT-4o' };
    }
  }

  // ── FREE ROUTING (after limit OR simple questions) ──────────

  // Web search needed → Gemini Flash (best for current affairs)
  if (intent.needsWebSearch || webContext) {
    return { model: 'gemini-1.5-flash', isPremium: false, reason: 'Web/current affairs → Gemini Flash' };
  }

  // Math, coding, reasoning → DeepSeek (best free for logic)
  const mathSignals = ['math','maths','calculus','algebra','geometry','equation','solve','proof',
    'code','python','javascript','algorithm','programming','debug','error in code'];
  if (mathSignals.some(k => msg.includes(k))) {
    return { model: 'deepseek-chat', isPremium: false, reason: 'Math/coding → DeepSeek' };
  }

  // Summary, flashcards, quick revision → Groq Llama (fast + free)
  if (
    intent.mode === 'flashcards' ||
    intent.mode === 'summary' ||
    intent.mode === 'conversation'
  ) {
    return { model: 'llama-3.3-70b-versatile', isPremium: false, reason: 'Quick/conversational → Groq Llama' };
  }

  // Default free → Groq Llama 3.3 70B (capable + fast)
  return { model: 'llama-3.3-70b-versatile', isPremium: false, reason: 'General → Groq Llama' };
}

// ─────────────────────────────────────────────────────────────
// MODEL CALLERS
// ─────────────────────────────────────────────────────────────
async function callAI(model, messages, system) {
  // Fallback chain — if primary model fails, try next best, then gpt-4o-mini as final safety net
  const fallbackChain = {
    'claude-sonnet-4-6':         ['llama-3.3-70b-versatile', 'gpt-4o-mini'],
    'claude-3-5-haiku-20241022': ['llama-3.3-70b-versatile', 'gpt-4o-mini'],
    'gpt-4o':                    ['llama-3.3-70b-versatile', 'gpt-4o-mini'],
    'gemini-1.5-flash':          ['llama-3.3-70b-versatile', 'gpt-4o-mini'],
    'deepseek-chat':             ['llama-3.3-70b-versatile', 'gpt-4o-mini'],
    'llama-3.3-70b-versatile':   ['gpt-4o-mini'],
    'gpt-4o-mini':               []
  };

  const modelsToTry = [model, ...(fallbackChain[model] || ['gpt-4o-mini'])];

  for (const m of modelsToTry) {
    try {
      console.log(`[MODEL] Trying: ${m}`);
      if (m === 'claude-sonnet-4-6')          return await callClaude(messages, system, 'claude-sonnet-4-6');
      if (m === 'claude-3-5-haiku-20241022')   return await callClaude(messages, system, 'claude-3-5-haiku-20241022');
      if (m === 'gemini-1.5-flash')            return await callGemini(messages, system);
      if (m === 'llama-3.3-70b-versatile')     return await callGroq(messages, system, 'llama-3.3-70b-versatile');
      if (m === 'deepseek-chat')               return await callDeepSeek(messages, system);
      if (m === 'gpt-4o-mini')                 return await callOpenAI(messages, system, 'gpt-4o-mini');
      return await callOpenAI(messages, system, 'gpt-4o');
    } catch (err) {
      console.warn(`[MODEL] ${m} failed: ${err.message} — trying next fallback`);
      if (m === modelsToTry[modelsToTry.length - 1]) {
        // All fallbacks exhausted — throw final error
        throw new Error(`All models failed. Last error: ${err.message}`);
      }
      // Continue to next model in chain
    }
  }
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
  return { content: data.choices[0].message.content, model: modelName, usage: data.usage };
}

async function callClaude(messages, system, modelName = 'claude-sonnet-4-6') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelName, max_tokens: 1200, system, messages })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { content: data.content[0].text, model: modelName, usage: data.usage };
}

// ── Groq — Llama 3.3 70B (free, fast) ──────────────────────
async function callGroq(messages, system, modelName = 'llama-3.3-70b-versatile') {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.warn('[GROQ] No API key — falling back to gpt-4o-mini');
    return callOpenAI(messages, system, 'gpt-4o-mini');
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  if (data.error) {
    console.warn('[GROQ] Error:', data.error.message, '— falling back to gpt-4o-mini');
    return callOpenAI(messages, system, 'gpt-4o-mini');
  }
  return { content: data.choices[0].message.content, model: modelName, usage: data.usage };
}

// ── DeepSeek — best free for math/reasoning ────────────────
async function callDeepSeek(messages, system) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    console.warn('[DEEPSEEK] No API key — falling back to gpt-4o-mini');
    return callOpenAI(messages, system, 'gpt-4o-mini');
  }
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1200,
      temperature: 0.7
    })
  });
  const data = await res.json();
  if (data.error) {
    console.warn('[DEEPSEEK] Error:', data.error.message, '— falling back to gpt-4o-mini');
    return callOpenAI(messages, system, 'gpt-4o-mini');
  }
  return { content: data.choices[0].message.content, model: 'deepseek-chat', usage: data.usage };
}

// ─────────────────────────────────────────────────────────────
// DAILY PATTERN RECOGNITION
// Detects natural openings to learn more about the student
// Saves discoveries silently to user_memory.psych_insights
// Feels like a real mentor — not a quiz
// ─────────────────────────────────────────────────────────────
function detectPsychInsight(message, history, emotionData) {
  const msg = message.toLowerCase().trim();
  const recentHistory = history.map(m => (m.content||'').toLowerCase()).join(' ');

  // Map of triggers → what we learn → key to save
  const discoveries = [

    // Pressure handling
    {
      triggers: ['exam tomorrow','exam today','test tomorrow','paper tomorrow','only hours','running out of time'],
      insight: 'performs under pressure — exam panic triggers detected',
      key: 'pressure_style:deadline_driven'
    },
    {
      triggers: ['i work better under pressure','i need a deadline','procrastinate until last minute','last minute person'],
      insight: 'self-identified deadline-driven worker',
      key: 'pressure_style:needs_deadline'
    },
    {
      triggers: ['i plan everything','i like to plan','plan ahead','schedule it','i make lists'],
      insight: 'proactive planner — likes structure and preparation',
      key: 'pressure_style:advance_planner'
    },

    // How they react when stuck
    {
      triggers: ['i give up','want to quit','too hard','cant do this','not smart enough'],
      insight: 'tends to catastrophize when stuck — needs reframe before content',
      key: 'stuck_response:gives_up'
    },
    {
      triggers: ['let me try again','ill figure it out','give me a hint','almost got it'],
      insight: 'resilient when stuck — pushes through with small nudges',
      key: 'stuck_response:resilient'
    },

    // Learning preference signals
    {
      triggers: ['show me an example','give me an example','can you show','real life example'],
      insight: 'needs examples before theory — kinesthetic/sensing learner signal',
      key: 'learn_pref:examples_first'
    },
    {
      triggers: ['explain the concept first','what is the theory','how does it work fundamentally','first principles'],
      insight: 'prefers theory before examples — intuitive learner signal',
      key: 'learn_pref:theory_first'
    },
    {
      triggers: ['draw it','can you make a diagram','visualize','picture this','show me visually'],
      insight: 'requests visual representation — strong visual learner',
      key: 'learn_pref:visual_confirmed'
    },
    {
      triggers: ['step by step','one step at a time','break it down','slowly','smaller steps'],
      insight: 'needs chunked learning — prefers structured sequential delivery',
      key: 'learn_pref:chunked_sequential'
    },

    // Motivation signals
    {
      triggers: ['i want to prove','prove to myself','prove everyone wrong','show them'],
      insight: 'externally motivated — driven by proving themselves to others',
      key: 'motivation:prove_others'
    },
    {
      triggers: ['i just love learning','i find this fascinating','genuinely curious','this is interesting'],
      insight: 'intrinsically motivated — loves learning for its own sake',
      key: 'motivation:intrinsic_curiosity'
    },
    {
      triggers: ['if i fail','what if i fail','scared of failing','fear of failure','cant afford to fail'],
      insight: 'fear of failure is primary motivator — needs reassurance + reframe',
      key: 'motivation:fear_of_failure'
    },

    // Social/collaboration style
    {
      triggers: ['i study alone','i prefer studying alone','distraction when others around','need quiet'],
      insight: 'solo learner — introvert study preference confirmed',
      key: 'social_style:solo_learner'
    },
    {
      triggers: ['study group','i learn better with others','explaining to someone','teach someone'],
      insight: 'social learner — learns by explaining and collaborating',
      key: 'social_style:collaborative_learner'
    },

    // Emotional intelligence signals
    {
      triggers: ['i know im stressed but','i can feel myself getting anxious','i notice when im'],
      insight: 'high self-awareness — recognizes own emotional states',
      key: 'eq:high_self_awareness'
    },
    {
      triggers: ['i dont know why im feeling','i just feel off','something feels wrong','dont know whats wrong'],
      insight: 'lower emotional self-awareness — feelings arrive without clear source',
      key: 'eq:developing_self_awareness'
    },

    // Decision making
    {
      triggers: ['i overthink','i keep second guessing','analysis paralysis','cant make a decision'],
      insight: 'overthinking pattern — needs decisive framing and time-boxing',
      key: 'decision_style:overthinker'
    },
    {
      triggers: ['i just go for it','i decide quickly','trust my gut','follow my instinct'],
      insight: 'intuitive fast decision maker — needs to slow down for big decisions',
      key: 'decision_style:gut_driven'
    }
  ];

  // Check current message against all triggers
  for(const discovery of discoveries){
    if(discovery.triggers.some(t => msg.includes(t))){
      return { insight: discovery.insight, key: discovery.key };
    }
  }

  // Check recent history for patterns (catches things said a message or two ago)
  for(const discovery of discoveries){
    if(discovery.triggers.some(t => recentHistory.includes(t))){
      return { insight: discovery.insight, key: discovery.key };
    }
  }

  return { insight: null, key: null };
}

// ─────────────────────────────────────────────────────────────
// PROACTIVE MENTOR SYSTEM
// Detects goal confirmation and triggers personalised email sequences
// ─────────────────────────────────────────────────────────────

function detectProactiveTrigger(message, history, meta) {
  const msg = message.toLowerCase().trim();

  // ── HARD FILTER — skip short/casual messages immediately ──
  // Must be at least 5 words AND contain a goal/topic keyword
  const wordCount = msg.split(' ').filter(w => w.length > 0).length;
  if (wordCount < 5) return null;

  const hasGoalKeyword = [
    'prepare', 'preparation', 'study', 'learn', 'crack', 'clear',
    'interview', 'exam', 'target', 'goal', 'month', 'week', 'days'
  ].some(k => msg.includes(k));
  if (!hasGoalKeyword) return null;

  const recentHistory = history.slice(-6).map(m => (m.content||'').toLowerCase()).join(' ');
  const combined = msg + ' ' + recentHistory;

  // Goal/exam confirmation signals
  const goalSignals = [
    { pattern: /gmat.{0,20}(\d+)\s*month/i,       topic: 'GMAT',          extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /cat.{0,20}(\d+)\s*month/i,         topic: 'CAT',           extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /upsc.{0,20}(\d+)\s*month/i,        topic: 'UPSC',          extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /jee.{0,20}(\d+)\s*month/i,         topic: 'JEE',           extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /neet.{0,20}(\d+)\s*month/i,        topic: 'NEET',          extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /interview.{0,20}(\d+)\s*day/i,     topic: 'Interview Prep',extractDays: m => parseInt(m[1]) },
    { pattern: /interview.{0,10}tomorrow/i,        topic: 'Interview Prep',extractDays: () => 1 },
    { pattern: /interview.{0,10}(2|two)\s*day/i,   topic: 'Interview Prep',extractDays: () => 2 },
    { pattern: /ai engineer.{0,20}(\d+)\s*month/i, topic: 'AI Engineering',extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /product manager.{0,20}(\d+)\s*month/i, topic: 'Product Management', extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /learn.{0,20}python.{0,20}(\d+)\s*month/i, topic: 'Python', extractDays: m => parseInt(m[1]) * 30 },
    { pattern: /startup.{0,20}(\d+)\s*month/i,    topic: 'Entrepreneurship', extractDays: m => parseInt(m[1]) * 30 },
  ];

  // Check if user just confirmed a plan ("yes", "that works", "let's start", etc.)
  const confirmationSignals = [
    'yes', 'yeah', 'sure', 'ok', 'okay', 'lets start', 'that works',
    'sounds good', 'ready', 'lets do it', 'start from tomorrow',
    'are we ready', 'confirmed', 'im in', 'great lets go'
  ];
  const isConfirmation = confirmationSignals.some(s => msg.includes(s));

  // Look for goal in recent history if this is a confirmation
  if (isConfirmation) {
    for (const signal of goalSignals) {
      const match = combined.match(signal.pattern);
      if (match) {
        return {
          goal:          `Prepare for ${signal.topic}`,
          topic:         signal.topic,
          timeline_days: signal.extractDays(match),
          needsEmailConfirm: true
        };
      }
    }
  }

  // Direct goal statement with timeline
  for (const signal of goalSignals) {
    const match = msg.match(signal.pattern);
    if (match) {
      return {
        goal:          `Prepare for ${signal.topic}`,
        topic:         signal.topic,
        timeline_days: signal.extractDays(match),
        needsEmailConfirm: true
      };
    }
  }

  return null;
}

// Create schedule in Supabase and send Day 1 email
async function triggerProactiveMentor({ userId, userEmail, userName, learningStyle, personality, trigger, supabaseUrl, supabaseKey, baseUrl }) {
  if (!userId || !userEmail || !trigger) return;

  // Check if schedule already exists for this goal
  const existingRes = await fetch(
    `${supabaseUrl}/rest/v1/mentor_schedules?user_id=eq.${userId}&topic=eq.${encodeURIComponent(trigger.topic)}&status=eq.active&select=id`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
  );
  const existing = await existingRes.json().catch(() => []);
  if (existing && existing.length > 0) {
    console.log('[PROACTIVE] Schedule already exists for', trigger.topic);
    return;
  }

  // Create schedule in Supabase
  const scheduleRes = await fetch(`${supabaseUrl}/rest/v1/mentor_schedules`, {
    method: 'POST',
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation'
    },
    body: JSON.stringify({
      user_id:        userId,
      goal:           trigger.goal,
      topic:          trigger.topic,
      timeline_days:  trigger.timeline_days,
      current_day:    1,
      email:          userEmail,
      user_name:      userName,
      learning_style: learningStyle,
      personality:    personality,
      status:         'active',
      roadmap:        { completed_topics: [] },
      last_email_sent: new Date().toISOString()
    })
  });
  const schedule = await scheduleRes.json();
  const scheduleId = Array.isArray(schedule) ? schedule[0]?.id : schedule?.id;

  console.log('[PROACTIVE] Schedule created:', scheduleId, 'for', trigger.topic);

  // Send roadmap email immediately
  await fetch(`${baseUrl}/api/mentor-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'roadmap',
      schedule_id: scheduleId,
      context: {
        name:          userName,
        email:         userEmail,
        goal:          trigger.goal,
        topic:         trigger.topic,
        timeline_days: trigger.timeline_days,
        learning_style: learningStyle,
        personality:   personality,
        current_level: 'as discussed'
      }
    })
  });

  // If interview/exam is very soon (≤2 days), also send glossary immediately
  if (trigger.timeline_days <= 2) {
    await fetch(`${baseUrl}/api/mentor-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'glossary',
        context: {
          name:         userName,
          email:        userEmail,
          goal:         trigger.goal,
          topic:        trigger.topic,
          days_until:   trigger.timeline_days,
          learning_style: learningStyle
        }
      })
    });
    console.log('[PROACTIVE] Sent urgent glossary for', trigger.topic);
  }

  console.log('[PROACTIVE] ✅ Full proactive sequence triggered for', userName);
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
