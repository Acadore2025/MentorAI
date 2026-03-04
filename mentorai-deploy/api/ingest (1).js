// ============================================================
// api/ingest.js — MentorAI Knowledge Base Loader
// ============================================================
// Run ONCE to load all teaching content into Pinecone
// Call: POST /api/ingest
// Header: x-admin-secret: your_ADMIN_SECRET value
// Uses Pinecone integrated embedding (llama-text-embed-v2)
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
    const PINECONE_HOST    = process.env.PINECONE_HOST;

    if (!PINECONE_API_KEY || !PINECONE_HOST) {
      return res.status(500).json({ error: 'Missing PINECONE_API_KEY or PINECONE_HOST' });
    }

    const chunks = buildAllChunks();
    console.log(`Total chunks to ingest: ${chunks.length}`);

    const batchSize = 50;
    let totalUpserted = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      const records = batch.map(chunk => ({
        id: chunk.id,
        text: chunk.text,
        subject: chunk.subject,
        topic: chunk.topic,
        learning_style: chunk.learning_style,
        level: chunk.level,
        exam_relevance: chunk.exam_relevance,
        content_type: chunk.content_type
      }));

      const upsertRes = await fetch(`${PINECONE_HOST}/records/upsert`, {
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

      // Pinecone returns empty body on success — safe parse
      const rawText = await upsertRes.text();
      if (!upsertRes.ok) {
        throw new Error(`Pinecone error ${upsertRes.status}: ${rawText}`);
      }
      totalUpserted += batch.length;
      console.log(`Batch ${Math.floor(i / batchSize) + 1} done — ${totalUpserted}/${chunks.length}`);
      await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      success: true,
      message: `Ingested ${totalUpserted} teaching chunks into Pinecone`,
      breakdown: { topics: getAllTopics().length, styles: 4, chunk_types: 3, total: chunks.length }
    });

  } catch (err) {
    console.error('Ingest error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// CHUNK BUILDER — creates 3 chunks per topic per learning style
// 1. Main teaching chunk (explanation + analogy + real world)
// 2. Flashcards chunk
// 3. Practice questions chunk
// ─────────────────────────────────────────────────────────────
function buildAllChunks() {
  const chunks = [];
  const topics = getAllTopics();

  for (const topic of topics) {
    for (const style of ['visual', 'hands_on', 'story', 'logical']) {
      const v = topic.versions[style];
      if (!v) continue;

      // Chunk 1: Main teaching content
      chunks.push({
        id: `${topic.id}_${style}_main`,
        text: `SUBJECT: ${topic.subject}
TOPIC: ${topic.topic}
LEARNING STYLE: ${style.replace('_', ' ')}
LEVEL: ${topic.level}
EXAM: ${topic.exam_relevance}

EXPLANATION:
${v.explanation}

ANALOGY:
${v.analogy}

REAL WORLD CONNECTION:
${v.real_world}`,
        subject: topic.subject,
        topic: topic.topic,
        learning_style: style,
        level: topic.level,
        exam_relevance: topic.exam_relevance,
        content_type: 'teaching'
      });

      // Chunk 2: Flashcards
      chunks.push({
        id: `${topic.id}_${style}_flashcards`,
        text: `SUBJECT: ${topic.subject}
TOPIC: ${topic.topic}
LEARNING STYLE: ${style.replace('_', ' ')}
TYPE: FLASHCARDS

${v.flashcards.map((f, i) => `Q${i+1}: ${f.q}\nA${i+1}: ${f.a}`).join('\n\n')}`,
        subject: topic.subject,
        topic: topic.topic,
        learning_style: style,
        level: topic.level,
        exam_relevance: topic.exam_relevance,
        content_type: 'flashcards'
      });

      // Chunk 3: Practice questions
      chunks.push({
        id: `${topic.id}_${style}_practice`,
        text: `SUBJECT: ${topic.subject}
TOPIC: ${topic.topic}
LEARNING STYLE: ${style.replace('_', ' ')}
TYPE: PRACTICE QUESTIONS

${v.practice.map((p, i) => `Q${i+1}: ${p.q}\nSOLUTION: ${p.a}`).join('\n\n')}`,
        subject: topic.subject,
        topic: topic.topic,
        learning_style: style,
        level: topic.level,
        exam_relevance: topic.exam_relevance,
        content_type: 'practice'
      });
    }
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────
// ALL TOPICS — 4 LEARNING STYLES EACH
// ─────────────────────────────────────────────────────────────
function getAllTopics() {
  return [

    // ════════════════════════════════════════
    // PHYSICS
    // ════════════════════════════════════════
    {
      id: 'physics_newtons_first_law',
      subject: 'Physics',
      topic: "Newton's First Law of Motion",
      level: 'Class 9-11',
      exam_relevance: 'CBSE, JEE, NEET',
      versions: {
        visual: {
          explanation: "Newton's First Law: An object at rest stays at rest, and an object in motion stays in motion in a straight line at constant speed — unless an external force acts on it. Draw a ball with an arrow showing its velocity. Without any force arrows touching it, the arrow never changes. Add a friction arrow — the ball slows. Add a push arrow — it accelerates. The force arrows are the ONLY things that can change the velocity arrow.",
          analogy: "Draw a satellite orbiting Earth. No engine running. No fuel burning. Yet it moves forever — the arrow of its velocity never stops. That is Newton's First Law drawn in the night sky. On Earth we always have friction so things stop — making it LOOK like rest is natural and motion dies. Space reveals the truth: motion is just as natural as rest.",
          real_world: "Voyager 1 spacecraft was launched in 1977 with no continuous fuel. Right now it is 24 billion km from Earth, moving at 61,000 km/h — with nothing pushing it. That is Newton's First Law operating in real time, visible to your phone's NASA app.",
          flashcards: [
            {q: "What does Newton's First Law state?", a: "An object stays at rest or in uniform motion unless an external force acts on it."},
            {q: "What is Inertia?", a: "The resistance of any object to changes in its state of motion. More mass = more inertia."},
            {q: "Visualize: a book on a table. What forces act? Does First Law apply?", a: "Gravity down + Normal force up = zero net force. Book stays still. Yes, First Law — net force zero, no change."},
            {q: "Which has more inertia — a truck or a bicycle? Why?", a: "Truck — it has far greater mass. More mass = more resistance to any change in motion."},
            {q: "Draw what happens to a passenger when a bus brakes.", a: "Bus stops (force on bus). Passenger's body has inertia — continues forward while bus slows. That forward lurch is inertia."}
          ],
          practice: [
            {q: "A ball rolls on a rough floor and stops after 5m. A student says this proves Newton's First Law is wrong. How do you respond?", a: "The Law is not violated. Friction is the external force that stopped the ball. Remove friction (ice, space) and it keeps rolling forever. First Law applies when net force = 0 only."},
            {q: "A hockey puck slides on frictionless ice. What does First Law predict?", a: "It slides forever in a straight line at constant speed. No friction = no external force = no change in motion. Perfect demonstration of First Law."},
            {q: "Why does a karate expert break a brick by striking fast, not slow?", a: "Fast strike — brick's inertia means it cannot respond quickly to move away — it shatters under the force. Slow push — brick moves gradually as inertia is gradually overcome."}
          ]
        },
        hands_on: {
          explanation: "Do this RIGHT NOW. Put a coin on a piece of paper on a smooth table. Pull the paper FAST and FLAT. The coin stays behind. That is Newton's First Law happening in your hands. The coin did not want to move — its inertia resisted the change. The paper moved. The coin's inertia kept it in place. Every time you do this, you are repeating an experiment that defines the universe.",
          analogy: "Stack 5 coins. Flick the BOTTOM coin out with a ruler very fast. The top 4 coins drop straight down — they do not fly sideways. Their inertia kept them in place while the bottom coin moved horizontally. You just demonstrated Newton's First Law with pocket change.",
          real_world: "Why do cars have seatbelts? In a crash the car stops INSTANTLY. But YOUR body has inertia — it wants to keep moving forward at 60 km/h. The seatbelt is the external force that stops you. Without it you would go through the windscreen at full speed. Newton's First Law is written into every car's safety design.",
          flashcards: [
            {q: "Do the coin-paper experiment. What happened and why?", a: "Coin stays — inertia resisted change. Paper moved quickly beneath it. Coin had no time to receive force from paper."},
            {q: "Why do seatbelts exist? Explain using First Law.", a: "In a crash car stops suddenly. Your body has inertia and wants to keep moving forward. Seatbelt provides the external force to stop your body safely."},
            {q: "How do you demonstrate First Law with a stack of coins?", a: "Flick bottom coin fast. Top coins fall straight down — their inertia kept them in place horizontally."},
            {q: "Can you feel inertia? Describe how.", a: "Yes — when a vehicle brakes you feel pushed forward. When it accelerates you feel pushed back. That feeling is your inertia resisting the change."},
            {q: "A ball rolling on carpet stops faster than on tiles. Which Law explains this?", a: "First Law — carpet has more friction (larger external force), so more deceleration. Less friction = ball travels further (closer to First Law's prediction)."}
          ],
          practice: [
            {q: "You slide a book across a table and it stops. Is Newton's First Law violated?", a: "No. Friction is the external force that stopped it. On a frictionless surface it would slide forever. The Law states no change WITHOUT external force — friction is that force."},
            {q: "A ball is rolling in outer space with no forces acting on it. Describe its motion after 1 year.", a: "Same speed, same direction — forever. No force = no change. After 1 year it has traveled an enormous distance but is moving identically to when you first observed it."},
            {q: "Why do passengers in a turning car feel pushed to the outside?", a: "Car turns (direction changes) because of external force. Passengers' bodies have inertia — they want to keep going STRAIGHT. The car turns under them, making them feel pushed outward. This is inertia, not a real outward force."}
          ]
        },
        story: {
          explanation: "It is 1687. Isaac Newton, age 44, is writing Principia Mathematica — the most important science book ever written. He is challenging 2000 years of Aristotle's belief that objects naturally stop moving. Everyone believed motion needed a constant push to be maintained. Newton asked one revolutionary question: what if motion is just as natural as rest? What if things ONLY stop because something is stopping them? That question, and its answer, became Newton's First Law.",
          analogy: "Imagine you are an astronaut floating in deep space. You give a ball a gentle push. You watch it. One hour later — still moving. One day — still moving. One year — STILL moving, same speed, same direction. Nothing stops it because nothing is there to stop it. You are living inside Newton's First Law. Every second you float in space is a second the Law proves itself.",
          real_world: "The Voyager 1 spacecraft, launched September 5, 1977, has traveled over 24 billion kilometers. Its engines have been off for decades. Yet it still moves at 61,000 km/h — carrying golden records of Earth's music and sounds, drifting toward the stars. Nobody is pushing it. Newton's First Law is the only explanation needed. It will travel like this for billions of years.",
          flashcards: [
            {q: "What belief did Newton overturn with First Law?", a: "Aristotle's 2000-year-old idea that objects naturally stop and need constant force to keep moving."},
            {q: "What was Newton's revolutionary insight?", a: "Motion is just as natural as rest. Things stop only because something MAKES them stop — not because stopping is natural."},
            {q: "How does Voyager 1 demonstrate First Law?", a: "Launched 1977, engines off for decades, still moving at 61,000 km/h — nothing stops it in the vacuum of space."},
            {q: "Why did it take until Newton to discover this?", a: "On Earth, friction always stops moving things — making it LOOK like motion naturally ends. Only in space does the truth become obvious."},
            {q: "What is the 'natural state' of an object according to Newton vs Aristotle?", a: "Newton: both rest AND uniform motion are equally natural. Aristotle: rest is natural, motion requires constant force."}
          ],
          practice: [
            {q: "Aristotle said heavier objects fall faster. How does Newton's worldview challenge ALL of Aristotle's physics?", a: "Newton showed motion needs no maintenance force — only changes need force. Aristotle required constant force for motion. Newton's framework, validated by Galileo dropping balls, completely replaced Aristotelian physics."},
            {q: "Voyager 1 is 24 billion km away moving at 61,000 km/h with no fuel. What force is acting on it?", a: "Essentially zero net force (very weak gravity from distant stars, negligible). First Law predicts it moves forever — and it does. The Sun's gravity is now too weak to stop it."},
            {q: "A child says: I pushed a toy car and it stopped, so things naturally stop. How do you correct this using a story?", a: "Tell them: roll the same car on carpet (stops fast), on tiles (stops slower), on ice (stops very slowly). Each time less friction, travels further. Imagine no friction at all — it never stops. The car was never naturally stopping — friction was always stopping it."}
          ]
        },
        logical: {
          explanation: "Newton's First Law is mathematically contained within the Second Law. F = ma. When F = 0 (net force zero), then 0 = ma. Since mass m ≠ 0, we must have a = 0. Zero acceleration means velocity is constant. Constant velocity means constant speed AND direction — uniform motion in a straight line. Therefore: zero net force → object maintains exactly its current state of motion. This is the First Law, derived from the Second.",
          analogy: "Formally: Let v⃗(t) be the velocity vector of an object. Newton's Second Law: ΣF⃗ = m(dv⃗/dt). If ΣF⃗ = 0 then dv⃗/dt = 0 which means v⃗ = constant vector. A constant velocity vector means both magnitude (speed) AND direction are unchanged. Therefore the object moves in a straight line at constant speed. QED — First Law is a special case of Second Law.",
          real_world: "Einstein built Special Relativity on Newton's First Law — he called it the 'Principle of Inertia'. He asked: if First Law holds in all inertial frames, and light speed is constant, what must be true about space and time? The answer was time dilation and length contraction. Newton's First Law, taken to its logical extreme with the speed of light, produces Einstein's relativity — the most accurate theory in all of physics.",
          flashcards: [
            {q: "Derive Newton's First Law from the Second Law.", a: "F=ma. If F=0: 0=ma, m≠0, so a=0. a=dv/dt=0 means v=constant. Constant v = uniform motion. QED."},
            {q: "What is an inertial reference frame?", a: "A frame where Newton's First Law holds — objects with no net force stay at rest or move at constant velocity."},
            {q: "Is the Earth's surface an inertial frame?", a: "Approximately — it rotates and orbits the Sun so it is technically non-inertial. For most problems the rotation is negligible, so we treat Earth as inertial."},
            {q: "What did Einstein use Newton's First Law for?", a: "As the 'Principle of Inertia' — foundation of Special Relativity. He asked what happens if First Law holds in all frames AND light speed is constant."},
            {q: "Mathematically what does 'uniform motion' mean?", a: "dv⃗/dt = 0, meaning the velocity vector is constant — both magnitude and direction unchanged."}
          ],
          practice: [
            {q: "Prove that uniform circular motion violates Newton's First Law and therefore requires a net force.", a: "Circular motion: constant speed but direction changes continuously. Therefore velocity vector changes — dv/dt ≠ 0 — therefore a ≠ 0 — therefore net force ≠ 0. This centripetal force points toward center. First Law violated → force must exist."},
            {q: "In a non-inertial frame (accelerating car), a ball appears to accelerate backward with no visible force. Explain logically.", a: "In accelerating frame, pseudo-forces appear. Ball has no real force — it is the frame that accelerates. To an external inertial observer, the ball stays still while the car moves forward. Newton's Laws hold in inertial frames only. The backward acceleration is fictitious."},
            {q: "Two equal forces act on a 5kg mass in opposite directions. First Law predicts what?", a: "Net force = F + (-F) = 0. From First Law (or Second): a = F_net/m = 0/5 = 0. Object maintains its current state — stays at rest if at rest, continues at same velocity if moving."}
          ]
        }
      }
    },

    // ════════════════════════════════════════
    // MATHEMATICS
    // ════════════════════════════════════════
    {
      id: 'math_percentages',
      subject: 'Mathematics',
      topic: 'Percentages',
      level: 'Class 8-10, CAT, Banking, SSC',
      exam_relevance: 'CAT, IBPS, SBI, SSC CGL, CBSE',
      versions: {
        visual: {
          explanation: "Percent means per hundred. Draw a 10×10 grid of 100 squares. Shade 25 squares = 25%. Shade 50 = 50%. That is ALL a percentage is — a fraction of 100. Every percentage problem draws this grid in different sizes. 25% of 200? Two grids of 100 — shade 25 in each = 50 total. 25% of 200 = 50.",
          analogy: "Visualize a pizza cut into 100 equal slices. 30% = you ate 30 slices. 100% = whole pizza. 120% = you ate more than the whole pizza. This is possible in profit calculations — when your return exceeds your investment, profit percentage exceeds 100%. Draw each scenario.",
          real_world: "Every sale tag, bank statement, and report card uses percentage. 8% GST on ₹1000 = ₹80 extra. 30% discount on ₹800 = ₹240 off = pay ₹560. 75% attendance means 75 out of every 100 classes attended. Once you see percentages as part-of-hundred, calculations become instant.",
          flashcards: [
            {q: "What does percent mean?", a: "Per hundred. X% = X/100. It is just a fraction with denominator 100."},
            {q: "What is 25% of 200?", a: "25/100 × 200 = 50. Or: 25% = 1/4, and 1/4 of 200 = 50."},
            {q: "Convert 3/8 to percentage.", a: "3/8 × 100 = 37.5%"},
            {q: "Price rises from ₹200 to ₹250. Percentage increase?", a: "Increase = 50. % increase = (50/200) × 100 = 25%"},
            {q: "Quick mental trick: 10% of any number.", a: "Move decimal one place left. 10% of 350 = 35. 10% of 1250 = 125."}
          ],
          practice: [
            {q: "A shirt costs ₹800. 15% discount applied. Final price?", a: "Method 1: Discount = 15% of 800 = 120. Final = 800-120 = ₹680. Method 2: Pay 85% → 0.85×800 = ₹680."},
            {q: "Student scored 63 out of 75. Percentage score?", a: "(63/75)×100 = 84%"},
            {q: "Population was 5,00,000. Grew by 8%. New population?", a: "Growth = 8% of 500000 = 40000. New = 540000. Or: 108% of 500000 = 5,40,000."}
          ]
        },
        hands_on: {
          explanation: "Open your phone right now. Battery = X%. That is a percentage of energy remaining. Check a food label — Fat: 8g per 100g = 8%. Open any sale app — everything is percentages. You interact with percentages 20+ times daily. Now calculate: what percentage of your day do you actually study? (hours studying / 24) × 100. That number is your study percentage — and it probably needs to go up.",
          analogy: "Go to any shop. Pick up any sale item. Calculate the discounted price in your head before billing. Practice until you can calculate 15%, 20%, 25% of any price in under 5 seconds. This is not just useful — this skill, developed as a habit, means you will outperform 90% of students in percentage questions in any competitive exam.",
          real_world: "Credit card interest: 3% per MONTH sounds small. That is 36% per year. ₹10,000 debt becomes ₹13,600 in one year if you pay nothing. In 3 years: ₹10,000 × (1.03)³⁶ = ₹29,000+. This is why banks are profitable and many people stay in debt forever. Understanding percentages is literally financial self-defense.",
          flashcards: [
            {q: "Mental trick: 15% of any number.", a: "10% + 5%. 15% of 240: 10%=24, 5%=12, total=36."},
            {q: "If price goes up 20% then down 20%, is it the same price?", a: "NO. 100 → +20% = 120 → -20% = 96. Net loss 4%. The base changes!"},
            {q: "Mark up 40%, discount 20%. Net profit%?", a: "100 → ×1.4 = 140 → ×0.8 = 112. Net profit = 12%."},
            {q: "What % of 24 hours do 8 hours sleep represent?", a: "8/24 × 100 = 33.3%"},
            {q: "Practical: How to quickly find 18% GST?", a: "18% = 20% - 2%. Find 20% (÷5), subtract 2% (÷50). Faster than direct calculation."}
          ],
          practice: [
            {q: "You earn ₹30,000/month. Rent ₹9,500, food ₹6,000, transport ₹3,000. What % of income is each? What % is left?", a: "Rent: 31.7%, Food: 20%, Transport: 10%. Total spent: 61.7%. Remaining: 38.3% = ₹11,500."},
            {q: "Phone MRP ₹18,000. Online discount 15%, then cashback 5% on discounted price. Final effective price?", a: "After discount: 85% of 18000 = ₹15,300. Cashback: 5% of 15300 = ₹765. Final: 15300 - 765 = ₹14,535."},
            {q: "In CAT: 76 questions, +3 correct, -1 wrong. You attempt 60, score 141. How many correct?", a: "Let correct = x, wrong = 60-x. 3x - (60-x) = 141 → 4x = 201 → x = 50.25... so 50 correct, 10 wrong. Check: 150-10=140 ≠ 141. Correct = 50, score = 150-10 = 140. Adjust — 51 correct: 153-9=144. Try 50 correct, 10 wrong = 140. Attempt fewer questions for accuracy."}
          ]
        },
        story: {
          explanation: "In medieval Venice, merchants traded across the world. They needed a universal language of fairness: how do you split profits between partners fairly? How do you calculate interest on gold lent? The solution was per cento — per hundred. By 1400 AD, Italian merchants had created the modern percentage system. Every time you calculate a discount or tip, you are using a 600-year-old Venetian merchant's invention.",
          analogy: "Imagine you are a merchant in ancient Rome. You lend 100 gold coins and want 5 back as payment for the risk. That is 5 per centum — per hundred. Five percent. The word percent literally comes from Latin per centum. When Julius Caesar taxed conquered territories at 1% of grain, he was calculating the world's first documented percentage tax. You are doing Roman mathematics every time you check a sale.",
          real_world: "The 2008 global financial crisis happened because banks had given loans worth 300% of their actual assets — they lent ₹3 for every ₹1 they actually had. When just 3% of borrowers could not repay, the entire system collapsed. Millions lost their jobs and homes. Understanding that 3% of 300% means the whole system fails — that is a percentage calculation that changed history.",
          flashcards: [
            {q: "Where does the word percent come from?", a: "Latin 'per centum' = per hundred. Used by Roman and medieval Italian merchants."},
            {q: "How did the 2008 crisis relate to percentages?", a: "Banks lent 300% of their assets. 3% default rate destroyed the entire system — showing how percentages cascade catastrophically."},
            {q: "Why is compound interest more powerful than simple interest?", a: "Compound: interest earns interest. Simple: only original principal earns interest. Over time compound grows exponentially vs linearly."},
            {q: "What is Rule of 72?", a: "Divide 72 by interest rate to find years to double money. 8% interest: 72/8 = 9 years to double. Quick mental math for compound growth."},
            {q: "How did percentage enable global trade?", a: "Universal language of proportion — allowed fair profit-splitting, interest calculation, and taxation across different currencies and languages."}
          ],
          practice: [
            {q: "₹1,00,000 invested at 8% compound interest annually. Using Rule of 72, when does it double? Verify mathematically.", a: "Rule of 72: 72/8 = 9 years. Verify: 100000 × (1.08)⁹ = 100000 × 1.999 ≈ ₹1,99,900. Rule of 72 is extremely accurate!"},
            {q: "A company's revenue: Year 1: ₹10cr, Year 2: +30%, Year 3: -20%, Year 4: +15%. Final revenue?", a: "10 × 1.3 × 0.8 × 1.15 = 10 × 1.196 = ₹11.96 crore. Net growth over 3 years = 19.6%."},
            {q: "Banks lend at 15% annual interest. Borrower takes ₹5 lakh for 5 years (compound). Total repayment?", a: "5,00,000 × (1.15)⁵ = 5,00,000 × 2.011 = ₹10,05,678. They repay over ₹10 lakh for a ₹5 lakh loan. This is why interest rates matter enormously."}
          ]
        },
        logical: {
          explanation: "Every percentage problem is exactly one of three types: (1) Find percentage: (Part ÷ Whole) × 100. (2) Find the part: (Percentage × Whole) ÷ 100. (3) Find the whole: (Part × 100) ÷ Percentage. Identify which two values you have, apply the correct formula. Successive percentages MULTIPLY not add: 20% up then 30% up = 1.2 × 1.3 = 1.56 = 56% total increase. Never 50%.",
          analogy: "Percentage change = (New - Old) / Old × 100. This formula is universal. Revenue change, population change, temperature change, score change — same formula every time. Memorize it. For reverse percentage: if price after 20% increase is ₹1200, original = 1200/1.2 = ₹1000. Always divide by (1 + rate/100), never subtract the percentage from the increased value.",
          real_world: "In CAT DI (Data Interpretation), 40% of marks come from percentage calculations. The differentiator: speed. Memorize these fraction-to-percentage conversions: 1/3=33.33%, 1/6=16.67%, 1/7=14.28%, 1/8=12.5%, 1/9=11.11%, 1/11=9.09%. When you see 16.67% in data, instantly recognize it as 1/6. This saves 8-10 seconds per calculation — in CAT that is 3-4 extra questions.",
          flashcards: [
            {q: "Three types of percentage problems — formulas.", a: "(1) %=(Part/Whole)×100. (2) Part=(%×Whole)/100. (3) Whole=(Part×100)/%."},
            {q: "Price after 25% increase is ₹750. Original price?", a: "1.25 × original = 750. Original = 750/1.25 = ₹600. Never: 750 - 25% of 750."},
            {q: "Memorize: 1/6, 1/7, 1/8, 1/9 as percentages.", a: "1/6=16.67%, 1/7=14.28%, 1/8=12.5%, 1/9=11.11%"},
            {q: "Successive % formula: X% then Y% change.", a: "Multiply factors: (1±X/100)(1±Y/100). Not X±Y."},
            {q: "A is 25% more than B. B is what % less than A?", a: "A=1.25B → B=0.8A → B is 20% less than A. (Not 25%! Base changes.)"}
          ],
          practice: [
            {q: "Price rises 25%, then 20%, then falls 10%. Net change?", a: "1.25 × 1.20 × 0.90 = 1.35. Net increase = 35%."},
            {q: "A is 50% of B. B is 40% of C. What % of C is A?", a: "A = 0.5B. B = 0.4C. Therefore A = 0.5 × 0.4C = 0.2C = 20% of C."},
            {q: "Marked price 40% above cost. Discount 20% on marked price. Profit or loss %?", a: "Let CP=100. MP=140. SP=80% of 140=112. Profit = 12%. (Key insight: mark-up and discount don't cancel.)"}
          ]
        }
      }
    },

    // ════════════════════════════════════════
    // CHEMISTRY
    // ════════════════════════════════════════
    {
      id: 'chemistry_atoms_structure',
      subject: 'Chemistry',
      topic: 'Structure of the Atom',
      level: 'Class 9-11',
      exam_relevance: 'CBSE, JEE, NEET',
      versions: {
        visual: {
          explanation: "Draw an atom. Center: small dense nucleus containing protons (+) and neutrons (0). Outside: electrons (-) in shells/orbits at increasing distances. Shell 1: maximum 2 electrons. Shell 2: maximum 8. Shell 3: maximum 18. The outermost shell electrons are valence electrons — they determine ALL chemical behavior. Atomic number = number of protons (count them in your nucleus drawing).",
          analogy: "Atom = tiny solar system. Nucleus = Sun (heavy, central, 99.9% of mass). Electrons = planets orbiting in fixed paths. Unlike planets, electrons can only exist at specific energy levels — they cannot be between orbits. And unlike planets, electrons can jump between orbits by absorbing or releasing exact amounts of light energy.",
          real_world: "Carbon-12 and Carbon-14 are the same element — both have 6 protons (atomic number 6). But C-14 has 8 neutrons instead of 6. This makes it radioactive. Archaeologists use C-14 to date ancient objects up to 50,000 years old — carbon dating works because C-14 decays at a known rate.",
          flashcards: [
            {q: "Draw an atom of Carbon (atomic number 6, mass number 12).", a: "Nucleus: 6 protons + 6 neutrons. Shells: 2 electrons in shell 1, 4 electrons in shell 2. Valence electrons = 4."},
            {q: "What is atomic number?", a: "Number of protons in the nucleus. Defines the element. Equals electrons in a neutral atom."},
            {q: "What are isotopes?", a: "Atoms of the same element with same protons but different numbers of neutrons."},
            {q: "Maximum electrons in shells 1, 2, 3?", a: "Shell 1: 2. Shell 2: 8. Shell 3: 18. Formula: 2n²"},
            {q: "What are valence electrons?", a: "Electrons in the outermost shell. Determine chemical properties, bonding, and reactivity."}
          ],
          practice: [
            {q: "Chlorine has atomic number 17. Draw electron configuration.", a: "2,8,7. Shell 1: 2, Shell 2: 8, Shell 3: 7. Valence electrons = 7. Needs 1 more to complete octet — explains why Cl forms Cl⁻ ions."},
            {q: "Carbon-12 and Carbon-14 — are they the same element? Explain.", a: "Yes — both have 6 protons (atomic number = 6 = Carbon). C-12 has 6 neutrons (mass 12). C-14 has 8 neutrons (mass 14). Same element, different isotopes."},
            {q: "An ion has 11 protons and 10 electrons. What is it? What charge?", a: "11 protons = Sodium (Na). 10 electrons (one fewer than protons). Charge = +1. It is Na⁺ — the sodium ion found in table salt."}
          ]
        },
        hands_on: {
          explanation: "Build an atom model with household items. Use a small ball of clay as the nucleus. Roll tiny bits of clay for protons (color 1) and neutrons (color 2) — press them together. Use wire or string to make circular orbits around the nucleus. Place small beads or seeds on the orbits as electrons. Build Carbon: 6 protons + 6 neutrons in nucleus, 2 electrons on orbit 1, 4 on orbit 2. You just built a Carbon atom.",
          analogy: "Take any round fruit — orange, apple. Cut it in half. The seeds clustered at the center = nucleus (protons and neutrons packed together). The flesh and skin = mostly empty space where electrons orbit. The fruit is mostly NOTHING — just like an atom is mostly empty space. If the nucleus were a marble, the nearest electron orbit would be 1 kilometer away.",
          real_world: "If you could remove all the empty space from every atom in a human body, the remaining matter would be smaller than a grain of sand — but it would weigh the same 70kg. You are 99.9999999% empty space. Everything solid around you is 99.9999999% empty. Atoms are almost entirely nothing — yet they feel completely solid. That is because electromagnetic forces between electron clouds create the sensation of solidity.",
          flashcards: [
            {q: "Build a model: what represents protons, neutrons, electrons?", a: "Nucleus (clay ball): colored clay for protons and neutrons. Orbits (wire rings): beads as electrons. Shell 1 has 2 beads max."},
            {q: "If the nucleus were a marble (1cm), how far away is the nearest electron?", a: "Approximately 1 kilometer away. The atom is 99.9999999% empty space."},
            {q: "How do you find the number of neutrons from atomic data?", a: "Neutrons = Mass number - Atomic number. Carbon-14: 14-6 = 8 neutrons."},
            {q: "What happens when an electron absorbs energy (light)?", a: "It jumps to a higher energy level (outer shell). When it falls back, it releases that energy as light — this is how neon signs and stars produce colored light."},
            {q: "How is a carbon-12 atom different from a carbon-14 atom? Feel the difference.", a: "Heavier — carbon-14 has 2 extra neutrons in its nucleus making it slightly heavier. Chemically identical — same electron configuration, same bonding behavior."}
          ],
          practice: [
            {q: "Build Sodium (Na, atomic number 11). How many electrons in each shell?", a: "Configuration: 2,8,1. Shell 1: 2, Shell 2: 8, Shell 3: 1. One lonely valence electron — why Na easily gives it away to form Na⁺. This explains sodium's high reactivity."},
            {q: "Rutherford fired alpha particles at gold foil. Most passed through. A few bounced back. What does this prove?", a: "Most passes through = atom is mostly empty space. Few bounce back = there is a tiny, dense, positive nucleus. This disproved Thomson's plum pudding model and revealed nuclear structure."},
            {q: "Why does Helium (atomic number 2) not react with anything?", a: "He has 2 electrons — Shell 1 is completely full (maximum 2). Full outermost shell = no need to gain, lose, or share electrons. Chemically completely stable — noble gas."}
          ]
        },
        story: {
          explanation: "In 1897, J.J. Thomson discovered the electron and thought atoms were like plum pudding — positive dough with negative electron raisins scattered throughout. In 1911, Ernest Rutherford fired particles at gold foil expecting them all to pass through the soft pudding. Instead, some bounced straight back. Rutherford later said: 'It was as if you fired artillery shells at tissue paper and they came back and hit you.' The nuclear atom was born from that astonishment.",
          analogy: "Imagine you are blindfolded trying to understand the inside of a room. You throw rubber balls in random directions. Most fly through easily — the room is mostly empty. But occasionally one bounces straight back — there must be something small and hard at the center. That is EXACTLY what Rutherford did with atoms in 1911. He threw alpha particles and used the bouncing pattern to discover the nucleus.",
          real_world: "Hiroshima and Nagasaki in 1945. The atomic bombs released energy from inside atomic nuclei — specifically from the mass difference when Uranium-235 nuclei split. E=mc² says that tiny mass (m) times c² (speed of light squared = 9×10¹⁶) = enormous energy. The mass difference was less than 1% of the atom's mass. Yet it destroyed entire cities. The power hidden inside atoms — discovered by understanding atomic structure — changed history forever.",
          flashcards: [
            {q: "What did Thomson discover and what was his atomic model?", a: "Thomson discovered the electron (1897). Model: atom = positive sphere with electrons embedded throughout (plum pudding model)."},
            {q: "What did Rutherford's gold foil experiment prove?", a: "Atom is mostly empty space. Tiny, dense, positive nucleus at center. Disproved plum pudding model."},
            {q: "Why was Rutherford astonished when alpha particles bounced back?", a: "He expected them to pass through soft positive dough. Bounce-back proved there was a hard, concentrated, positive nucleus — completely unexpected."},
            {q: "Who discovered the neutron and when?", a: "James Chadwick in 1932. Nucleus was thought to have only protons until then. Neutrons explained why atoms were heavier than their proton count alone."},
            {q: "How does atomic structure relate to nuclear weapons?", a: "Nuclear bombs split heavy nuclei (fission) or fuse light nuclei (fusion). Mass difference converts to energy via E=mc². Discovered by understanding atomic and nuclear structure."}
          ],
          practice: [
            {q: "If Rutherford had used thin paper instead of gold foil, would his experiment work? Why gold?", a: "Gold was chosen because it can be beaten into extremely thin layers (just a few atoms thick). It is also unreactive (does not oxidize, giving consistent results). Other metals oxidize and create impure surfaces. Gold's malleability was scientifically essential."},
            {q: "Bohr improved Rutherford's model. What problem did Bohr solve?", a: "Rutherford's orbiting electrons should spiral into nucleus releasing energy (classical physics prediction). Bohr fixed this by proposing electrons exist ONLY in specific energy levels and do not radiate energy unless jumping between levels. This matched hydrogen's emission spectrum exactly."},
            {q: "Carbon-14 dating: A bone has 25% of original C-14 remaining. C-14 half-life is 5730 years. How old is the bone?", a: "25% = 1/4 = (1/2)². Two half-lives have passed. Age = 2 × 5730 = 11,460 years old."}
          ]
        },
        logical: {
          explanation: "Atomic structure follows quantum mechanical rules. Electrons occupy orbitals (probability distributions), not fixed orbits. Four quantum numbers define each electron: n (principal, shell number), l (azimuthal, subshell), ml (magnetic, orbital orientation), ms (spin, +1/2 or -1/2). Pauli Exclusion Principle: no two electrons in same atom can have identical quantum numbers. Aufbau: fill lowest energy orbitals first. Hund's Rule: maximize unpaired electrons in same subshell.",
          analogy: "Quantum numbers are like a unique address for each electron. n = city, l = neighborhood, ml = building, ms = apartment (A or B). Pauli Exclusion: no two electrons live at the exact same address. Aufbau: fill cheapest apartments (lowest energy) first. Hund's Rule: in same building, one person per room before doubling up (maximize parallel spins).",
          real_world: "The periodic table IS quantum mechanics made visible. Each period = new principal quantum number (n). Groups = same valence electron configuration. d-block (transition metals) = d subshell filling. f-block (lanthanides, actinides) = f subshell filling. Periodic trends (atomic radius, ionization energy, electronegativity) all derive directly from quantum mechanical atomic structure. Mendeleev's table predicted quantum mechanics before quantum mechanics was discovered.",
          flashcards: [
            {q: "Four quantum numbers and what each represents.", a: "n: principal (energy level/shell), l: azimuthal (subshell shape), ml: magnetic (orbital orientation), ms: spin (+1/2 or -1/2)."},
            {q: "Pauli Exclusion Principle.", a: "No two electrons in an atom can have all four quantum numbers identical. Each electron has a unique quantum address."},
            {q: "Aufbau Principle.", a: "Electrons fill orbitals in order of increasing energy: 1s, 2s, 2p, 3s, 3p, 4s, 3d, 4p..."},
            {q: "Electron configuration of Iron (Fe, atomic number 26).", a: "1s² 2s² 2p⁶ 3s² 3p⁶ 4s² 3d⁶. Or [Ar] 4s² 3d⁶."},
            {q: "Why does 4s fill before 3d?", a: "4s has lower energy than 3d for neutral atoms (Aufbau order). After 3d is filled in transition metals, the 3d electrons are actually lower energy."}
          ],
          practice: [
            {q: "Write electron configuration of Cu (atomic number 29). Note: it is an exception.", a: "Expected: [Ar]4s²3d⁹. Actual: [Ar]4s¹3d¹⁰. Completely filled 3d (3d¹⁰) gives extra stability. One electron moved from 4s to 3d. Exception to Aufbau — Cr and Cu are the most important exceptions."},
            {q: "How many unpaired electrons does Fe²⁺ have? (Fe=26, loses 2 electrons from 4s)", a: "Fe: [Ar]4s²3d⁶. Fe²⁺ loses 4s electrons first: [Ar]3d⁶. 3d has 5 orbitals. 6 electrons by Hund's Rule: 5 orbitals get one each, one orbital gets second. Unpaired = 4."},
            {q: "Why are noble gases chemically inert? Use quantum mechanical reasoning.", a: "Noble gases have completely filled outermost s and p subshells (ns²np⁶ except He: 1s²). This represents maximum stability — zero net spin, symmetric electron distribution, no tendency to gain/lose/share electrons. Adding or removing electrons would disrupt this stability at significant energy cost."}
          ]
        }
      }
    },

    // ════════════════════════════════════════
    // BIOLOGY
    // ════════════════════════════════════════
    {
      id: 'biology_photosynthesis',
      subject: 'Biology',
      topic: 'Photosynthesis',
      level: 'Class 9-12',
      exam_relevance: 'CBSE, NEET',
      versions: {
        visual: {
          explanation: "Draw a leaf cross-section. On top surface: stomata (tiny pores) letting in CO₂. Chloroplasts (green oval organelles) inside leaf cells absorbing sunlight. Roots deliver H₂O up through the stem via xylem tubes. Overall equation drawn as arrows: 6CO₂ + 6H₂O + Sunlight → C₆H₁₂O₆ (glucose) + 6O₂. Arrow goes INTO the leaf: CO₂ and H₂O and light. Arrow comes OUT: O₂ (through stomata) and glucose (stays in plant).",
          analogy: "The leaf is a solar-powered food factory. Sunlight = electricity to power the factory. CO₂ = raw material delivered through air vents (stomata). H₂O = raw material delivered by pipes (xylem). Chlorophyll = solar panels absorbing the electricity. Glucose = the product made. O₂ = waste product released. The entire factory runs on free solar energy.",
          real_world: "Every breath you take is possible because of photosynthesis. Every piece of food you eat is stored photosynthesis energy. Coal, oil, and gas are fossilized photosynthesis from 300 million years ago. The entire food chain starts here. Remove photosynthesis and all complex life on Earth disappears within weeks.",
          flashcards: [
            {q: "Write the photosynthesis equation.", a: "6CO₂ + 6H₂O + Light energy → C₆H₁₂O₆ + 6O₂"},
            {q: "Where does photosynthesis occur in the cell?", a: "In chloroplasts — specifically the thylakoid membranes (light reactions) and stroma (dark reactions/Calvin cycle)."},
            {q: "What is chlorophyll?", a: "Green pigment in chloroplasts that absorbs light energy (mainly red and blue wavelengths, reflects green)."},
            {q: "What are stomata?", a: "Tiny pores mainly on leaf underside. Allow CO₂ in and O₂ out. Opened/closed by guard cells."},
            {q: "What are the two stages of photosynthesis?", a: "Light reactions (in thylakoids): capture light energy, split water, produce ATP and NADPH. Calvin cycle/dark reactions (in stroma): use ATP+NADPH to fix CO₂ into glucose."}
          ],
          practice: [
            {q: "A plant is placed in a sealed jar. CO₂ levels drop over 6 hours in bright light. What is happening?", a: "Plant is photosynthesizing — using CO₂ and light to make glucose and O₂. CO₂ drops because it is being consumed. If also dark respiration occurs, O₂ also being used, but net effect in bright light is CO₂ decrease."},
            {q: "Why do leaves appear green?", a: "Chlorophyll absorbs red and blue light wavelengths for photosynthesis but REFLECTS green wavelengths. Our eyes see the reflected green light — therefore leaves look green."},
            {q: "A variegated leaf (green and white patches) is tested for starch. Where will starch be found?", a: "Only in green patches. White patches lack chlorophyll — cannot photosynthesize — cannot produce glucose — cannot store starch. This is a standard CBSE experiment proving chlorophyll is essential."}
          ]
        },
        hands_on: {
          explanation: "Put a water plant (Hydrilla from any aquarium shop) in a beaker of water in bright sunlight. Watch tiny bubbles rise from the leaves. Those bubbles ARE oxygen — the product of photosynthesis happening in real time. Count the bubbles per minute in sunlight vs shade — you are measuring the rate of photosynthesis with your own eyes. This is a real experiment done in labs worldwide.",
          analogy: "Take a leaf and cover half with black paper. Leave the plant in sunlight for 6 hours. Remove the paper. Dip the leaf in boiling water (kills cells), then in alcohol (removes chlorophyll — leaf turns white/pale). Dip in iodine solution. The uncovered half turns blue-black (starch present = photosynthesis happened). Covered half stays pale yellow-brown (no starch = no photosynthesis without light). You just proved light is essential for photosynthesis with your hands.",
          real_world: "Go outside and hold a leaf up to sunlight. The green color you see is chlorophyll reflecting the sunlight it cannot use. Inside that leaf, right now, solar energy is being captured and converted into sugar. Every green surface on Earth is a tiny solar panel manufacturing food. The Amazon rainforest alone produces 20% of Earth's oxygen through this process happening in trillions of leaves simultaneously.",
          flashcards: [
            {q: "Describe the Hydrilla experiment. What do bubbles prove?", a: "Aquatic plant in sunlight releases O₂ bubbles. Count bubbles/minute = measure of photosynthesis rate. More light = more bubbles = faster photosynthesis."},
            {q: "How do you test a leaf for starch?", a: "1. Boil in water (stops reactions). 2. Boil in alcohol (removes chlorophyll). 3. Rinse in water. 4. Add iodine. Blue-black = starch present."},
            {q: "Why is alcohol used in the starch test?", a: "To remove chlorophyll (decolorize the leaf). Green chlorophyll masks the iodine color change. Alcohol dissolves chlorophyll, making the starch test visible."},
            {q: "What happens to photosynthesis rate when you increase CO₂?", a: "Rate increases (up to a limit). CO₂ is a reactant — more of it allows faster Calvin cycle reactions. Greenhouse growers pump extra CO₂ to increase crop yields."},
            {q: "What three factors limit photosynthesis rate?", a: "Light intensity, CO₂ concentration, temperature. Whichever is lowest = limiting factor — controls the rate."}
          ],
          practice: [
            {q: "You do Hydrilla experiment: 10 bubbles/min in dim light, 25 in medium, 40 in bright, 40 in very bright. What does this tell you?", a: "Photosynthesis rate increased with light up to a point (25→40) then plateaued. Something else became limiting — probably CO₂ concentration or temperature. Light is no longer the limiting factor at very bright intensity."},
            {q: "A plant kept in CO₂-free air but bright light. Will photosynthesis occur?", a: "No — CO₂ is a raw material. Without CO₂, the Calvin cycle cannot fix carbon into glucose. The light reactions can still occur (producing O₂ from water splitting), but no net glucose is produced."},
            {q: "Why do plants release CO₂ at night but O₂ during the day?", a: "Day: photosynthesis (uses CO₂, produces O₂) > respiration (uses O₂, produces CO₂). Net: O₂ released. Night: only respiration occurs. Net: CO₂ released. Both processes run simultaneously — day/night balance differs."}
          ]
        },
        story: {
          explanation: "3.5 billion years ago, Earth had no oxygen. The atmosphere was CO₂, nitrogen, and methane — toxic to modern life. Then single-celled cyanobacteria evolved the ability to split water molecules using sunlight — the first photosynthesis. Over 2 billion years, their oxygen byproduct accumulated, transforming Earth's atmosphere from poisonous to breathable. Every breath you take is the legacy of microscopic bacteria that invented photosynthesis 3.5 billion years ago.",
          analogy: "Imagine a world where plants are the only factories, and sunlight is the only energy source. Every animal, including you, is entirely dependent on these factories. The grass a cow eats is solar energy. The cow's milk is solar energy. The bread you eat is solar energy. Even the coal and oil we burn is ancient solar energy captured by plants 300 million years ago. We have never invented any energy — we only transform energy that plants first captured from the sun.",
          real_world: "Jan Ingenhousz discovered in 1779 that plants absorb CO₂ and release O₂ only in sunlight — but release CO₂ in darkness. He tested this with aquatic plants in sealed glass jars — exactly like the Hydrilla experiment you do today. A doctor from Netherlands with a jar of water and some plants uncovered how all life on Earth feeds itself. His experiment, done with simple equipment, changed our understanding of life forever.",
          flashcards: [
            {q: "When did photosynthesis first evolve on Earth?", a: "~3.5 billion years ago in cyanobacteria. Their oxygen output gradually transformed Earth's atmosphere over 2 billion years."},
            {q: "Who discovered that photosynthesis requires light?", a: "Jan Ingenhousz (1779) — showed plants release O₂ in light, CO₂ in dark using aquatic plants in sealed jars."},
            {q: "Why is photosynthesis called the most important chemical reaction on Earth?", a: "It is the entry point of ALL energy into living systems. Every food chain starts here. It also produces all atmospheric oxygen."},
            {q: "How are fossil fuels connected to photosynthesis?", a: "Coal, oil, gas = fossilized remains of organisms that captured solar energy via photosynthesis 300+ million years ago. We are burning ancient photosynthesis."},
            {q: "What would happen if photosynthesis stopped globally tomorrow?", a: "O₂ levels would drop within years. Food chains would collapse within weeks. Most complex life would be extinct within months."}
          ],
          practice: [
            {q: "3.5 billion years ago, early photosynthesis changed Earth's atmosphere. Describe this change and its consequences.", a: "Before: atmosphere was mostly CO₂, methane, N₂ — no free O₂. Cyanobacteria split water, releasing O₂. Over 2 billion years, O₂ accumulated (Great Oxygenation Event ~2.4 billion years ago). O₂ formed ozone layer blocking UV. This allowed life to colonize land. Without this, no complex multicellular life would have evolved."},
            {q: "A scientist claims to have created artificial photosynthesis. What inputs and outputs would this system need?", a: "Inputs: CO₂ (from air), H₂O (water), light energy (sunlight or artificial). Outputs: glucose or other carbohydrate (fuel), O₂. The challenge is replicating the efficiency of chlorophyll and the electron transport chain. Artificial photosynthesis could solve both energy and food problems simultaneously."},
            {q: "All the carbon in your body came from atmospheric CO₂. Trace the journey of a carbon atom from air to your muscle.", a: "CO₂ enters leaf via stomata → fixed into glucose (C₆H₁₂O₆) in Calvin cycle → plant stores glucose as starch or uses for growth → you eat plant → digestion breaks starch to glucose → cells use glucose in cellular respiration, releasing energy → carbon atoms incorporated into ATP, CO₂ released, or built into proteins/fats. Your muscles are literally made of rearranged air."}
          ]
        },
        logical: {
          explanation: "Photosynthesis has two stages: Light-dependent reactions (thylakoid membranes): photons excite chlorophyll electrons → electron transport chain → ATP and NADPH produced → water split (photolysis) → O₂ released. Calvin Cycle/light-independent reactions (stroma): CO₂ fixed by RuBisCO enzyme → glucose synthesized using ATP+NADPH from light reactions. Net equation derived: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂. For every glucose: 18 ATP, 12 NADPH consumed.",
          analogy: "Photosynthesis = two-stage manufacturing. Stage 1 (light reactions): Convert solar energy to chemical energy currency (ATP, NADPH). Like charging batteries. Stage 2 (Calvin cycle): Use those charged batteries to build glucose from CO₂. Like running a factory on the charged batteries. Decouple them: chloroplasts in dark still have charged batteries (ATP/NADPH) and can run Calvin cycle briefly without light. Shine light but block CO₂: light reactions run, batteries charge, but factory has no raw material.",
          real_world: "C3, C4, and CAM plants differ in carbon fixation strategy. C3 plants (rice, wheat): standard Calvin cycle, CO₂ fixed directly by RuBisCO. Problem: photorespiration wastes energy in hot, dry conditions. C4 plants (maize, sugarcane): pre-fix CO₂ in mesophyll cells, concentrate it near RuBisCO — reduces photorespiration. More efficient in hot climates. CAM plants (cacti): fix CO₂ at night (stomata open) store it, use during day (stomata closed) — maximizes water efficiency in desert. Understanding this biochemistry helps breed more efficient crop plants.",
          flashcards: [
            {q: "Where do light reactions occur? What do they produce?", a: "Thylakoid membranes of chloroplasts. Produce: ATP, NADPH, O₂ (from water splitting/photolysis)."},
            {q: "Where does Calvin cycle occur? What does it use and produce?", a: "Stroma of chloroplasts. Uses: ATP, NADPH, CO₂. Produces: G3P (glyceraldehyde-3-phosphate), which becomes glucose."},
            {q: "What is the role of RuBisCO?", a: "Enzyme that catalyzes CO₂ fixation in Calvin cycle — attaches CO₂ to RuBP (5-carbon). Most abundant enzyme on Earth."},
            {q: "What is photolysis?", a: "Splitting of water molecules by light energy in thylakoids. 2H₂O → 4H⁺ + 4e⁻ + O₂. Source of all photosynthetic O₂."},
            {q: "Why is C4 photosynthesis more efficient than C3 in hot climates?", a: "C4 concentrates CO₂ around RuBisCO, suppressing photorespiration (where O₂ competes with CO₂). Higher photosynthesis efficiency in hot, sunny conditions."}
          ],
          practice: [
            {q: "Chloroplasts are isolated and given light but no CO₂. What happens?", a: "Light reactions continue: chlorophyll absorbs light, water is split (O₂ released), ATP and NADPH produced. Calvin cycle halts — no CO₂ to fix. ATP/NADPH accumulate but no glucose produced. Eventually light reactions also slow as ATP/NADPH build up (no consumption)."},
            {q: "Write the balanced equations for light reactions and Calvin cycle separately.", a: "Light reactions: 12H₂O + 12NADP⁺ + 18ADP + 18Pi → 6O₂ + 12NADPH + 18ATP. Calvin cycle: 6CO₂ + 12NADPH + 18ATP → C₆H₁₂O₆ + 12NADP⁺ + 18ADP + 18Pi + 6H₂O. Combined = overall photosynthesis equation."},
            {q: "A plant in red light vs green light — which photosynthesizes faster? Why?", a: "Red light — faster. Chlorophyll absorbs red and blue light strongly (action spectrum peaks). Green light is mostly REFLECTED by chlorophyll — that is why plants appear green. Very little green light energy is captured for photosynthesis."}
          ]
        }
      }
    },

    // ════════════════════════════════════════
    // CAT / MBA — LOGICAL REASONING
    // ════════════════════════════════════════
    {
      id: 'cat_logical_reasoning',
      subject: 'CAT / MBA Preparation',
      topic: 'Logical Reasoning — Seating Arrangements',
      level: 'CAT, XAT, IBPS PO, SBI PO',
      exam_relevance: 'CAT, XAT, IBPS, SBI PO, CLAT',
      versions: {
        visual: {
          explanation: "Draw a table or circle FIRST before reading all clues. For circular arrangements: draw a circle, number the seats 1-8. Place the most constrained person first (the one with the most conditions). Then place relatives to that person. Cross out impossible positions as you go. ALWAYS draw — never try to solve seating arrangement in your head. The diagram IS the solution method.",
          analogy: "Seating arrangement is like a jigsaw puzzle. You do not look at all pieces at once — you find the corner pieces first (most constrained people), then edges, then fill in the middle. In seating: find the person with 3+ conditions → place them first → everyone else becomes easier to place relative to the anchor.",
          real_world: "Event managers solve seating arrangements every day — for weddings, conferences, Parliament sessions. They use the same visual grid method: draw the table/hall first, place VIPs with most constraints first, fill in remaining seats. The CAT seating arrangement is identical to real event management — just smaller scale.",
          flashcards: [
            {q: "What is the first step in any seating arrangement?", a: "Draw the diagram immediately — table (linear or rectangular) or circle. Never attempt mentally."},
            {q: "In a circular arrangement of 8 people, how many arrangements relative to one fixed person?", a: "Fix one person (eliminate rotation equivalence). Remaining 7 people: 7! = 5040 arrangements. But CAT gives constraints that reduce this drastically."},
            {q: "Linear vs circular seating — key difference?", a: "Linear: ends are different. Circular: no fixed ends, rotations are same arrangement. Fix one person in circular to count distinct arrangements."},
            {q: "What does 'immediate neighbor' mean vs 'next to'?", a: "Same thing — sitting directly adjacent (one seat away). Distinguish from 'second to the left' (two seats away)."},
            {q: "How do you handle 'facing each other' in circular arrangements?", a: "In circular table: directly opposite = (n/2) seats away. In CAT sets this means the two people sit across the center of the circle."}
          ],
          practice: [
            {q: "6 people A,B,C,D,E,F sit in a circle. A is between B and C. D sits opposite A. E is not next to D. Where does F sit?", a: "Draw circle. Fix A. B and C are on A's immediate left and right (try both). D is directly opposite A (3 seats away in 6-person circle). E cannot be next to D — so E is not in seats adjacent to D. F fills remaining seat. Work through both B-left/C-right and B-right/C-left cases."},
            {q: "What is the fastest approach when a seating problem has 5+ clues?", a: "1. Draw diagram. 2. Find most constrained person (most clues about them). 3. Place them. 4. Use each clue one by one. 5. When stuck, try both possibilities for one ambiguous clue and see which one leads to contradiction. Eliminate the contradiction — answer is the other option."},
            {q: "8 people sit in 2 rows of 4 facing each other. A faces B. C is to the right of A. How does 'right' work here?", a: "Always define direction from the person's perspective (not viewer's perspective). Draw Person A facing down (toward row 2). A's right = the viewer's left. This is the most common mistake in seating arrangement — always confirm direction convention from the problem."}
          ]
        },
        hands_on: {
          explanation: "Sit 6 friends or family members around a round dining table. Read them a set of conditions: 'A must sit next to B, C must not sit next to D, E must face F.' Watch them physically rearrange themselves until all conditions are met. This is EXACTLY what the CAT question does — just described in text. Once you do this physically, solving it on paper becomes dramatically easier because you understand what the words mean.",
          analogy: "Use coins to solve seating arrangements. Label 6 coins A-F with a marker. Draw a circle on paper with 6 positions. Physically move coins around until all conditions are satisfied. This kinesthetic approach — actually moving objects — makes the abstract constraints concrete and visible. After doing 10 problems this way, your brain builds a spatial model that works even without coins.",
          real_world: "Solve this real problem: Your family of 6 is going to a wedding. Round table. Grandmother must sit next to either Mum or Dad. Your cousin A and cousin B had a fight — cannot sit next to each other. You (the organizer) sit facing the main stage. Work out the seating. Use coins. This is a real CAT problem disguised as family planning — and you will care more about solving it.",
          flashcards: [
            {q: "Physical practice: use coins labeled A-F. Draw circle. Practice placing under time pressure.", a: "Set timer for 8 minutes per arrangement problem. Real CAT gives you 3-4 minutes. Physical practice builds speed."},
            {q: "What is the #1 mistake students make in seating arrangements?", a: "Not drawing the diagram immediately. Trying to hold the arrangement in their head. Always draw first, always."},
            {q: "How do you verify your seating solution?", a: "Go through EVERY clue one by one after placing everyone. If any clue is violated, your solution is wrong. Never submit without verification check."},
            {q: "What if you get stuck midway with 2 possible positions for someone?", a: "Try both and continue. One will lead to a contradiction with later clues — eliminate it. This trial method is faster than trying to logically determine the position without attempting."},
            {q: "In competitive exams, seating arrangement sets have 4-5 questions from one setup. What is the strategy?", a: "Solve the arrangement ONCE correctly. All 4-5 questions then become immediate lookups. Spending 4-5 minutes on the setup can earn 12-20 marks — highest ROI in the entire LR section."}
          ],
          practice: [
            {q: "7 friends sit in a circle: P,Q,R,S,T,U,V. P is between Q and R. S is not next to P. T is opposite P (in a 7-person circle, 'opposite' means 3-4 seats away — check which). Solve the arrangement.", a: "7-person circle has no exact opposite (odd number). 'Opposite' likely means as far as possible = 3 or 4 seats away. Draw the circle, fix P, place Q and R on each side of P, mark positions 3 and 4 away from P for T (try both), ensure S avoids P's neighbors. Work systematically through remaining positions for U and V."},
            {q: "You are solving a CAT set with 5 seating questions. You spent 6 minutes and got the arrangement. But Q4 seems impossible with your arrangement. What do you do?", a: "Re-read ALL clues looking for one you misread or misapplied. Likely you made an error in one early clue that propagated. Start the arrangement from scratch — it is faster than trying to fix a wrong arrangement. In CAT, a wrong arrangement means all 5 questions are wrong — worth the restart time."},
            {q: "8 executives sit around a board table (circular). CEO sits north. CFO is 2 seats to CEO's right. COO is directly opposite CEO. CMO is between CFO and COO. Remaining 4 have no specific conditions. How many possible complete arrangements are there?", a: "CEO fixed (north). CFO fixed (2 right of CEO). COO fixed (opposite CEO = south). CMO fixed (between CFO and COO). That constrains 4 seats definitively. Remaining 4 executives fill 4 remaining seats: 4! = 24 possible arrangements."}
          ]
        },
        story: {
          explanation: "Imagine you are Sherlock Holmes. A murder has been committed at a dinner party. 8 guests sat around a table. Your job: reconstruct exactly who sat where using only witness statements. 'I sat next to the Colonel.' 'The Doctor sat opposite the Widow.' 'Lady Smith was between two men.' Each clue is a logical constraint. Solve the seating arrangement and you know who had access to the victim. CAT seating arrangement IS Sherlock Holmes — every clue is a constraint, every solution is a deduction.",
          analogy: "The CAT seating arrangement is the world's smallest logic puzzle — compressed into 5 clues and 6-8 people. But the same thinking that solves it also solves supply chain problems, traffic routing, network optimization, and scheduling. When you master seating arrangements, you are training your brain's constraint-satisfaction ability — the same cognitive skill used by engineers, lawyers, and strategists every day.",
          real_world: "Indian Parliament's Lok Sabha has 543 MPs. The Speaker assigns seats based on party, seniority, and protocol. No two rival party leaders sit adjacent during sensitive sessions. Coalition partners sit in coordinated sections. Major disruptions have occurred because of seating arrangements — the physical arrangement reflects and affects political dynamics. Understanding seating arrangements is understanding how human organization works.",
          flashcards: [
            {q: "How is a seating arrangement problem like detective work?", a: "Each clue is a constraint. Combine constraints to eliminate impossible arrangements. The remaining possibility must be correct. Sherlock Holmes method: eliminate the impossible."},
            {q: "What real-world skill does seating arrangement build?", a: "Constraint satisfaction — given multiple conditions, find the configuration that satisfies all simultaneously. Used in engineering, law, logistics, and management."},
            {q: "In CAT 2023, seating arrangements in LRDI contributed approximately what percentage of marks?", a: "Approximately 25-35% of LRDI section. Mastering arrangements alone can secure a significant percentile jump."},
            {q: "What is the 'anchor and build' strategy?", a: "Find the most constrained person (most clues about them = the anchor). Place them first. Build all other positions relative to the anchor. Systematic and fast."},
            {q: "When should you skip a seating arrangement set in CAT?", a: "If after 2 minutes you cannot place the first anchor, the set is too complex for your current level — skip and return. Spending 15 minutes on one unsolvable set destroys your overall score."}
          ],
          practice: [
            {q: "Sherlock approach: 6 suspects in a circle. A says: I sat between two women. B says: I was opposite A. C says: The person to my left was male. D says: I was not next to B or A. E is female. F is female. Who are the two women next to A?", a: "A is between two women. E and F are female. Therefore A is between E and F. B is opposite A (3 seats away). D not next to B or A — eliminates certain seats. C's left neighbor is male. Work through placing D first (not adjacent to A or B) — places C and D in remaining seats. C's left neighbor male clue resolves final ambiguity."},
            {q: "Why do CAM students say seating arrangement is the 'make or break' section in LRDI?", a: "A single set has 4-5 questions worth 12-20 marks. Solve it correctly = massive percentile boost. Spend 12 minutes and fail = catastrophic for score. The ROI is extremely high — high reward, high risk. Students who can reliably solve arrangements in under 6 minutes have a massive advantage."},
            {q: "Describe a system for solving seating arrangements under exam pressure.", a: "Step 1: Draw diagram immediately (30 seconds). Step 2: Read ALL clues once before placing anyone (1 min). Step 3: Place most constrained person. Step 4: Use each clue once. Step 5: When stuck, try both options for ambiguous placement. Step 6: After completing arrangement, verify ALL clues (1 min). Step 7: Answer all questions from the verified diagram. Total target: 5-7 minutes for full set."}
          ]
        },
        logical: {
          explanation: "Seating arrangement problems are constraint satisfaction problems (CSP). Variables: positions 1 to n. Domain: set of people. Constraints: conditions from clues. Solution: assignment of people to positions satisfying all constraints simultaneously. Solve using constraint propagation: each clue reduces the domain of each variable. When domain reduces to 1 value, that variable is solved. Propagate this new information to further reduce other domains.",
          analogy: "Represent as a matrix: rows = people, columns = positions, cell = true/false (can this person sit here?). Initially all cells true. Apply each constraint: mark false where constraint violated. When a row has only one 'true' — person's position is determined. Propagate. This systematic elimination is the formal algorithmic solution — identical to how Sudoku solvers work.",
          real_world: "Constraint Satisfaction Problems (CSP) power: GPS route planning (constraints: roads, traffic, distance), university timetabling (constraints: room capacity, professor availability, no student conflict), airline scheduling (constraints: aircraft availability, crew hours, gate availability). Seating arrangement is the simplest CSP. Master the method here, and you understand the logic behind systems that schedule millions of flights, students, and routes daily.",
          flashcards: [
            {q: "What type of mathematical problem is a seating arrangement?", a: "Constraint Satisfaction Problem (CSP) — find assignment of variables to values satisfying all constraints."},
            {q: "What is constraint propagation?", a: "Using one confirmed position to eliminate impossible positions for other people. Each solved position generates new constraints for remaining unknowns."},
            {q: "In a 6-person circular arrangement, what is the maximum information one clue can give?", a: "One clue that fixes one person relative to a fixed reference constrains 2 positions. Most constraining: clues that eliminate half the remaining possibilities."},
            {q: "How do you handle 'NOT next to' constraints efficiently?", a: "In your diagram, mark pairs that CANNOT be adjacent. As you place people, these constraints eliminate specific positions. Often more useful later in the solving process when fewer positions remain."},
            {q: "When is backtracking needed in seating arrangements?", a: "When two possible positions exist for a person (ambiguous clue) and neither leads to immediate contradiction. Place one arbitrarily, continue — if contradiction occurs, backtrack and try the other."}
          ],
          practice: [
            {q: "Formalize: 6 people A,B,C,D,E,F. Circular. Clue 1: A adjacent to B. Clue 2: C not adjacent to A. Clue 3: D opposite B. Express as CSP with constraint matrix.", a: "Variables: P1-P6 (positions). Domain: {A,B,C,D,E,F}. Constraints: (1)|pos(A)-pos(B)|=1 or 5 (circular adjacency). (2)|pos(C)-pos(A)|≠1 and ≠5. (3)|pos(D)-pos(B)|=3 (opposite in 6-person circle). Fix A at position 1 (remove rotational symmetry). Then B at 2 or 6. D at pos(B)±3. C not at 2 or 6 (not adjacent to A at 1). Remaining positions for E and F are unconstrained."},
            {q: "A CAT LRDI set has seating with 8 people in 2 rows of 4 facing each other. How many distinct arrangements are possible if 2 specific people must face each other and 2 must not sit in same row?", a: "Row 1: 4 seats. Row 2: 4 seats. 'Face each other' means one is in Row 1, one in Row 2, directly opposite. Fix them in one facing pair (8 positions for them, but constrained to opposite seats). Count: 8 facing pairs. Second constraint: 2 people in different rows = one in each row. Calculate arrangements respecting both constraints. Total = (2×1) for first pair × (arrangements of remaining with cross-row constraint). Detailed calculation depends on which pairs are specified."},
            {q: "You have solved the seating arrangement but question asks 'who sits to the immediate right of X in a circular arrangement?' How do you determine 'right' unambiguously?", a: "In circular arrangements, 'right' is always defined from the perspective of the person seated (facing the center). A's right = the person in the clockwise direction from A (when A faces center). If the problem specifies everyone faces inward, clockwise = each person's right. Standardize: re-read whether the arrangement specifies facing direction. When ambiguous, note both possibilities and see which makes all other clues consistent."}
          ]
        }
      }
    }
  ];
}
