require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const META_API_VERSION   = 'v19.0';
const PHONE_NUMBER_ID    = process.env.META_PHONE_NUMBER_ID;   // 1169972786209768
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const VERIFY_TOKEN       = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';

const LESSON_READY_TEMPLATE = 'lesson_ready'; // approved Utility template

// ─────────────────────────────────────────────
// META GRAPH API HELPERS
// ─────────────────────────────────────────────

/**
 * Send a free-form text message (only valid within a 24-hour service window).
 */
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[MSG] Text sent to ${to}`);
  } catch (err) {
    console.error('[ERR] sendTextMessage:', err.response?.data || err.message);
  }
}

/**
 * Send the approved lesson_ready Utility template.
 * This opens the 24-hour window once the subscriber replies.
 */
async function sendLessonReadyTemplate(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: LESSON_READY_TEMPLATE,
          language: { code: 'en' },
          // No variable components — template body is static
        },
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[TEMPLATE] lesson_ready sent to ${to}`);
  } catch (err) {
    console.error('[ERR] sendLessonReadyTemplate:', err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────

async function getSubscriber(phone) {
  const { data, error } = await supabase
    .from('subscribers')
    .select('*')
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[ERR] getSubscriber:', error);
  return data || null;
}

async function upsertSubscriber(phone, updates) {
  const { error } = await supabase
    .from('subscribers')
    .upsert({ phone, ...updates }, { onConflict: 'phone' });
  if (error) console.error('[ERR] upsertSubscriber:', error);
}

async function getLesson(lessonNumber) {
  const { data, error } = await supabase
    .from('lessons')
    .select('*')
    .eq('lesson_number', lessonNumber)
    .eq('track', 'copywriting')
    .single();
  if (error) console.error('[ERR] getLesson:', error);
  return data || null;
}

// ─────────────────────────────────────────────
// AI FEEDBACK
// ─────────────────────────────────────────────

async function getAIFeedback(lessonTitle, taskDescription, subscriberSubmission) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `You are a supportive copywriting coach at SkillStack NG, a micro-learning platform for Nigerians learning high-income skills.

Lesson: "${lessonTitle}"
Task: "${taskDescription}"
Subscriber's submission: "${subscriberSubmission}"

Give warm, practical feedback in 3 short sections:
1. ✅ What they did well (1-2 sentences)
2. 💡 One thing to improve (1-2 sentences, specific)  
3. 🚀 Encouragement + what's coming tomorrow (1 sentence)

Keep it under 120 words. Write like a friendly Nigerian mentor who genuinely wants them to succeed.`,
        },
      ],
    });
    return message.content[0].text;
  } catch (err) {
    console.error('[ERR] getAIFeedback:', err.message);
    return "Great work submitting your task! Your coach will review it. Keep going — consistency is everything. See you tomorrow! 🚀";
  }
}

// ─────────────────────────────────────────────
// LESSON DELIVERY
// ─────────────────────────────────────────────

/**
 * Send the full lesson content to a subscriber.
 * Called after they reply to the lesson_ready template (opening the 24hr window).
 */
async function deliverFullLesson(phone, subscriber) {
  const lessonNum = subscriber.current_lesson || 1;
  const lesson = await getLesson(lessonNum);

  if (!lessonNum || lessonNum > 65) {
    await sendTextMessage(
      phone,
      `🎓 *Congratulations!*\n\nYou've completed all 65 lessons of the SkillStack NG Copywriting Track!\n\nYou're now a trained copywriter. Go out there and get clients. We're proud of you. 🙌\n\nLook out for our next track coming soon.`
    );
    await upsertSubscriber(phone, { status: 'completed' });
    return;
  }

  if (!lesson) {
    await sendTextMessage(phone, `⚠️ We had a hiccup loading your lesson. Please reply with *LESSON* and we'll resend it.`);
    return;
  }

  // Format and send the lesson
  const lessonText =
    `📚 *Day ${lesson.lesson_number}: ${lesson.title}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${lesson.content}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✏️ *Today's Task:*\n${lesson.task}\n\n` +
    `_Reply with your task submission to get AI feedback. You have 24 hours._`;

  await sendTextMessage(phone, lessonText);

  // Mark that lesson has been delivered; waiting for task submission
  await upsertSubscriber(phone, {
    lesson_delivered_at: new Date().toISOString(),
    awaiting_task: true,
    last_active: new Date().toISOString(),
  });

  console.log(`[LESSON] Lesson ${lessonNum} delivered to ${phone}`);
}

// ─────────────────────────────────────────────
// ONBOARDING FLOW
// ─────────────────────────────────────────────

async function handleOnboarding(phone, messageText, subscriber) {
  const text = messageText.trim().toLowerCase();
  const stage = subscriber?.onboarding_stage || 'new';

  // ── Stage: new / no record ──
  if (!subscriber || stage === 'new') {
    await upsertSubscriber(phone, {
      status: 'onboarding',
      onboarding_stage: 'name',
      current_lesson: 1,
      streak: 0,
    });
    await sendTextMessage(
      phone,
      `👋 Welcome to *SkillStack NG*!\n\nWe teach Nigerians high-income skills in 15 minutes a day — delivered right here on WhatsApp.\n\n` +
      `Our current track: *Copywriting* 📝\n65 lessons. 90 days. Real skills. Real income potential.\n\n` +
      `Let's get you started. *What's your first name?*`
    );
    return;
  }

  // ── Stage: waiting for name ──
  if (stage === 'name') {
    const name = messageText.trim().split(' ')[0];
    await upsertSubscriber(phone, {
      name,
      onboarding_stage: 'goal',
    });
    await sendTextMessage(
      phone,
      `Nice to meet you, *${name}*! 🙌\n\nQuick question — *why do you want to learn copywriting?*\n\n` +
      `Reply with a number:\n1️⃣ I want to freelance and earn from clients\n2️⃣ I want to improve my own business marketing\n3️⃣ I want to work in marketing/advertising\n4️⃣ Just curious / exploring`
    );
    return;
  }

  // ── Stage: waiting for goal ──
  if (stage === 'goal') {
    const goalMap = { '1': 'freelancing', '2': 'business marketing', '3': 'marketing career', '4': 'exploring' };
    const goal = goalMap[text] || 'personal growth';
    await upsertSubscriber(phone, {
      goal,
      onboarding_stage: 'payment_pending',
    });
    await sendTextMessage(
      phone,
      `Love that. ${goal === 'freelancing' ? 'Freelancing is one of the fastest ways to earn in Nigeria right now.' : 'Great reason to start.'} 💪\n\n` +
      `Here's what's included:\n✅ 65 expert-written lessons\n✅ Daily AI feedback on your tasks\n✅ Monday–Friday delivery (weekends = rest)\n✅ Streak tracking to keep you accountable\n\n` +
      `*Investment: ₦5,000/month*\n\nPay here 👇\n${process.env.PAYSTACK_PAYMENT_LINK}\n\n` +
      `Once you've paid, reply *DONE* and your lessons start the next morning. 🚀`
    );
    return;
  }

  // ── Stage: payment pending ──
  if (stage === 'payment_pending') {
    if (text === 'done' || text === 'paid') {
      const name = subscriber.name || 'there';
      await upsertSubscriber(phone, {
        status: 'active',
        onboarding_stage: 'complete',
        subscribed_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      });
      await sendTextMessage(
        phone,
        `✅ *You're in, ${name}!*\n\nWelcome to SkillStack NG — you've made a great decision.\n\n` +
        `📅 Your first lesson arrives *tomorrow morning*.\n` +
        `📲 We'll send a notification when it's ready — just reply to open the lesson.\n\n` +
        `_Tip: Save this number as "SkillStack NG" so you never miss a message._\n\nSee you tomorrow! 🎯`
      );
    } else {
      await sendTextMessage(
        phone,
        `To complete your enrollment, pay ₦5,000 here:\n${process.env.PAYSTACK_PAYMENT_LINK}\n\nThen reply *DONE* and we'll activate your account. 👆`
      );
    }
    return;
  }
}

// ─────────────────────────────────────────────
// ACTIVE SUBSCRIBER MESSAGE HANDLER
// ─────────────────────────────────────────────

async function handleActiveSubscriber(phone, messageText, subscriber) {
  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  // Manual lesson trigger (support / missed reply)
  if (lowerText === 'lesson' || lowerText === 'send lesson') {
    await deliverFullLesson(phone, subscriber);
    return;
  }

  // Status check
  if (lowerText === 'status' || lowerText === 'progress') {
    const name = subscriber.name || 'Learner';
    const lesson = subscriber.current_lesson || 1;
    const streak = subscriber.streak || 0;
    const total = 65;
    const pct = Math.round(((lesson - 1) / total) * 100);
    await sendTextMessage(
      phone,
      `📊 *Your SkillStack Progress, ${name}*\n\n` +
      `📚 Lesson: ${lesson - 1} of ${total} completed (${pct}%)\n` +
      `🔥 Current streak: ${streak} day${streak !== 1 ? 's' : ''}\n` +
      `⏭️ Next lesson: Day ${lesson}\n\n` +
      `Keep it going! Consistency is the skill.`
    );
    return;
  }

  // Help menu
  if (lowerText === 'help' || lowerText === 'menu') {
    await sendTextMessage(
      phone,
      `📋 *SkillStack NG Help*\n\n` +
      `Reply with:\n` +
      `• *LESSON* — Get today's lesson now\n` +
      `• *STATUS* — See your progress\n` +
      `• *HELP* — Show this menu\n\n` +
      `For support, reply with your question and we'll get back to you.`
    );
    return;
  }

  // ── OPTION A CORE FLOW ──
  // Subscriber replied to the lesson_ready template → deliver the lesson
  if (subscriber.template_sent && !subscriber.lesson_delivered_at) {
    await deliverFullLesson(phone, subscriber);
    await upsertSubscriber(phone, { template_sent: false });
    return;
  }

  // Subscriber is submitting a task
  if (subscriber.awaiting_task && text.length > 20) {
    const lessonNum = (subscriber.current_lesson || 1);
    const lesson = await getLesson(lessonNum);

    await sendTextMessage(phone, `⏳ Analysing your submission...`);

    const feedback = await getAIFeedback(
      lesson?.title || `Day ${lessonNum}`,
      lesson?.task || 'Complete the task',
      text
    );

    await sendTextMessage(phone, `🤖 *AI Feedback on Your Task:*\n\n${feedback}`);

    // Advance to next lesson
    const nextLesson = lessonNum + 1;
    const newStreak = (subscriber.streak || 0) + 1;

    await upsertSubscriber(phone, {
      current_lesson: nextLesson,
      streak: newStreak,
      awaiting_task: false,
      lesson_delivered_at: null,
      last_active: new Date().toISOString(),
    });

    if (nextLesson <= 65) {
      await sendTextMessage(
        phone,
        `🔥 *Streak: ${newStreak} day${newStreak !== 1 ? 's' : ''}!*\n\nLesson ${lessonNum} done. Day ${nextLesson} arrives tomorrow morning. See you then! 💪`
      );
    }
    return;
  }

  // Generic reply — light acknowledgement, don't spam
  // (Could be a reply to template that arrives before lesson_delivered_at logic catches it)
  if (subscriber.template_sent) {
    await deliverFullLesson(phone, subscriber);
    await upsertSubscriber(phone, { template_sent: false });
    return;
  }
}

// ─────────────────────────────────────────────
// WEBHOOK ROUTES
// ─────────────────────────────────────────────

// Verification
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming messages
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always ACK immediately

  try {
    const entry    = req.body?.entry?.[0];
    const change   = entry?.changes?.[0];
    const value    = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg  = messages[0];
    const from = msg.from;                                      // e.g. "2348012345678"
    const type = msg.type;

    let messageText = '';
    if (type === 'text') {
      messageText = msg.text?.body || '';
    } else if (type === 'interactive') {
      messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else {
      // Non-text (image, audio, etc.) — acknowledge and return
      return;
    }

    console.log(`[INCOMING] From: ${from} | Text: "${messageText}"`);

    const subscriber = await getSubscriber(from);

    if (!subscriber || subscriber.status === 'onboarding' || !subscriber.onboarding_stage || subscriber.onboarding_stage !== 'complete') {
      await handleOnboarding(from, messageText, subscriber);
    } else {
      await handleActiveSubscriber(from, messageText, subscriber);
    }
  } catch (err) {
    console.error('[ERR] Webhook handler:', err);
  }
});

// ─────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────

/**
 * Daily lesson notification — runs Mon–Fri at 7:00 AM WAT (6:00 AM UTC).
 * Sends the lesson_ready template to all active subscribers who haven't
 * received today's lesson yet.
 *
 * OPTION A FLOW:
 *   1. Bot sends lesson_ready template (this cron)
 *   2. Subscriber replies (any text)
 *   3. 24-hour window opens
 *   4. handleActiveSubscriber() detects template_sent=true → delivers full lesson
 */
cron.schedule('0 6 * * 1-5', async () => {
  console.log('[CRON] Daily lesson notification running...');
  try {
    const { data: subscribers, error } = await supabase
      .from('subscribers')
      .select('*')
      .eq('status', 'active')
      .lte('current_lesson', 65);

    if (error) { console.error('[ERR] Cron fetch:', error); return; }
    if (!subscribers || subscribers.length === 0) { console.log('[CRON] No active subscribers.'); return; }

    for (const sub of subscribers) {
      try {
        await sendLessonReadyTemplate(sub.phone);
        await upsertSubscriber(sub.phone, {
          template_sent: true,
          template_sent_at: new Date().toISOString(),
          lesson_delivered_at: null, // reset so today's lesson can be delivered
        });
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[ERR] Cron send to ${sub.phone}:`, err.message);
      }
    }
    console.log(`[CRON] lesson_ready template sent to ${subscribers.length} subscribers`);
  } catch (err) {
    console.error('[ERR] Cron job:', err);
  }
}, {
  timezone: 'Africa/Lagos',
});

/**
 * Saturday review message — runs every Saturday at 10:00 AM WAT.
 */
cron.schedule('0 10 * * 6', async () => {
  console.log('[CRON] Saturday review running...');
  try {
    const { data: subscribers } = await supabase
      .from('subscribers')
      .select('*')
      .eq('status', 'active');

    if (!subscribers) return;

    for (const sub of subscribers) {
      const name = sub.name || 'Learner';
      const lessonsThisWeek = Math.min(5, (sub.current_lesson || 1) - 1);
      const streak = sub.streak || 0;

      await sendTextMessage(
        sub.phone,
        `🎉 *Week in Review, ${name}!*\n\n` +
        `This week you completed ${lessonsThisWeek} lesson${lessonsThisWeek !== 1 ? 's' : ''}.\n` +
        `🔥 Streak: ${streak} day${streak !== 1 ? 's' : ''}\n\n` +
        `Rest up this weekend — your next lesson drops Monday morning. 💪\n\n` +
        `_Every lesson is a brick. Keep laying them._`
      );
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error('[ERR] Saturday cron:', err);
  }
}, {
  timezone: 'Africa/Lagos',
});

/**
 * Re-engagement — runs every Wednesday at 11:00 AM WAT.
 * Pings subscribers who haven't submitted a task in 3+ days.
 */
cron.schedule('0 11 * * 3', async () => {
  console.log('[CRON] Re-engagement check running...');
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: subscribers } = await supabase
      .from('subscribers')
      .select('*')
      .eq('status', 'active')
      .lt('last_active', threeDaysAgo);

    if (!subscribers || subscribers.length === 0) return;

    for (const sub of subscribers) {
      const name = sub.name || 'there';
      await sendTextMessage(
        sub.phone,
        `👋 Hey ${name}, just checking in!\n\nWe noticed you haven't submitted a task in a few days.\n\n` +
        `No pressure — life happens. But your streak and skills are waiting. 💡\n\n` +
        `Reply *LESSON* anytime to get back on track. We're rooting for you! 🚀`
      );
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[CRON] Re-engagement sent to ${subscribers.length} subscribers`);
  } catch (err) {
    console.error('[ERR] Re-engagement cron:', err);
  }
}, {
  timezone: 'Africa/Lagos',
});

// ─────────────────────────────────────────────
// HEALTH CHECK + DEMO PAGE
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SkillStack NG',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SkillStack NG bot running on port ${PORT}`);
  console.log(`Meta Phone Number ID: ${PHONE_NUMBER_ID}`);
  console.log(`Template: ${LESSON_READY_TEMPLATE}`);
  console.log(`Cron jobs: Mon-Fri 7am WAT (lessons), Sat 10am WAT (review), Wed 11am WAT (re-engagement)`);
});
