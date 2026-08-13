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
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const META_API_VERSION   = 'v19.0';
const PHONE_NUMBER_ID    = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const VERIFY_TOKEN       = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';

const LESSON_READY_TEMPLATE = 'lesson_ready';

// ─────────────────────────────────────────────
// META GRAPH API HELPERS
// ─────────────────────────────────────────────

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

async function getLesson(lessonNumber, track) {
  const { data, error } = await supabase
    .from('lessons')
    .select('*')
    .eq('lesson_number', lessonNumber)
    .eq('track', track || 'copywriting')
    .single();
  if (error) console.error('[ERR] getLesson:', error);
  return data || null;
}

// ─────────────────────────────────────────────
// AI FEEDBACK
// ─────────────────────────────────────────────

async function getAIFeedback(lessonTitle, taskDescription, subscriberSubmission, feedbackPrompt) {
  try {
    const prompt = feedbackPrompt ||
      `You are a supportive coach at SkillStack NG, a micro-learning platform for Nigerians learning high-income skills.

Lesson: "${lessonTitle}"
Task: "${taskDescription}"
Subscriber's submission: "${subscriberSubmission}"

Give warm, practical feedback in 3 short sections:
1. ✅ What they did well (1-2 sentences)
2. 💡 One thing to improve (1-2 sentences, specific)
3. 🚀 Encouragement + what's coming tomorrow (1 sentence)

Keep it under 120 words. Write like a friendly Nigerian mentor who genuinely wants them to succeed.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].text;
  } catch (err) {
    console.error('[ERR] getAIFeedback:', err.message);
    return "Great work submitting your task! Keep going — consistency is everything. See you tomorrow! 🚀";
  }
}

// ─────────────────────────────────────────────
// LESSON DELIVERY
// ─────────────────────────────────────────────

async function deliverFullLesson(phone, subscriber) {
  const lessonNum = subscriber.current_lesson || 1;
  const track = subscriber.track || 'copywriting';
  const lesson = await getLesson(lessonNum, track);

  if (!lessonNum || lessonNum > 65) {
    const trackName = track === 'content_writing' ? 'Content Writing' : track === 'social_media_management' ? 'Social Media Management' : 'Copywriting';
    await sendTextMessage(
      phone,
      `🎓 *Congratulations!*\n\nYou've completed all 65 lessons of the SkillStack NG ${trackName} Track!\n\nYou're now a trained ${trackName.toLowerCase()} professional. Go out there and get clients. We're proud of you. 🙌\n\nLook out for our next track coming soon.`
    );
    await upsertSubscriber(phone, { status: 'completed' });
    return;
  }

  if (!lesson) {
    await sendTextMessage(phone, `⚠️ We had a hiccup loading your lesson. Please reply with *LESSON* and we'll resend it.`);
    return;
  }

  const lessonText =
    `📚 *Day ${lesson.lesson_number}: ${lesson.title}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${lesson.content}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✏️ *Today's Task:*\n${lesson.task}\n\n` +
    `_Reply with your task submission to get AI feedback. You have 24 hours._`;

  await sendTextMessage(phone, lessonText);

  await upsertSubscriber(phone, {
    lesson_delivered_at: new Date().toISOString(),
    awaiting_task: true,
    last_active: new Date().toISOString(),
  });

  console.log(`[LESSON] Lesson ${lessonNum} (${track}) delivered to ${phone}`);
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
      onboarding_stage: 'track_select',
      current_lesson: 1,
      streak: 0,
    });
    await sendTextMessage(
      phone,
      `👋 Welcome to *SkillStack NG*!\n\nWe teach Nigerians high-income skills in 15 minutes a day — delivered right here on WhatsApp.\n\n` +
      `Choose your track:\n\n` +
      `1️⃣ *Copywriting & Persuasion* — 90 days\nWrite sales copy, ads, email sequences, and landing pages. Earn ₦100k–₦500k per project.\n\n` +
      `2️⃣ *Social Media Management* — 90 days\nManage brand accounts professionally. Earn ₦80k–₦900k per month.\n\n` +
      `3️⃣ *Content Writing* — 90 days\nWrite blogs, newsletters, LinkedIn content and ghostwriting. Earn ₦50k–₦500k per month.\n\n` +
      `Reply *1*, *2*, or *3* to get started.`
    );
    return;
  }

  // ── Stage: track selection ──
  if (stage === 'track_select') {
    const trackMap = {
      '1': 'copywriting',
      '2': 'social_media_management',
      '3': 'content_writing',
    };
    const trackNameMap = {
      '1': 'Copywriting & Persuasion (90 days)',
      '2': 'Social Media Management (90 days)',
      '3': 'Content Writing (90 days)',
    };
    const selectedTrack = trackMap[text];
    const trackName = trackNameMap[text];

    if (!selectedTrack) {
      await sendTextMessage(phone, `Please reply with *1*, *2*, or *3* to choose your track.`);
      return;
    }

    await upsertSubscriber(phone, {
      track: selectedTrack,
      onboarding_stage: 'name',
    });
    await sendTextMessage(
      phone,
      `Great choice! *${trackName}* it is. 🎯\n\nWhat's your first name?`
    );
    return;
  }

  // ── Stage: waiting for name ──
  if (stage === 'name') {
    const name = messageText.trim().split(' ')[0];
    await upsertSubscriber(phone, {
      name,
      onboarding_stage: 'payment_pending',
    });
    const track = subscriber.track || 'copywriting';
    const isCW  = track === 'content_writing';
    const isSMM = track === 'social_media_management';

    const monthlyLink = isCW  ? 'https://paystack.shop/pay/01d0empofc'
                      : isSMM ? 'https://paystack.shop/pay/ec2kdwv0ku'
                      : process.env.PAYSTACK_PAYMENT_LINK;

    const fullLink = isCW  ? 'https://paystack.shop/pay/6gz2f87ft4'
                   : isSMM ? 'https://paystack.shop/pay/ok8zxwq28f'
                   : 'https://paystack.shop/pay/m0m9ofipj4';

    const fullPrice = isSMM ? '9,000 for 60 days (save 1,000)' : '13,000 for 90 days (save 2,000)';

    await sendTextMessage(
      phone,
      `Nice to meet you, *${name}*! 🙌\n\nHere's what's included in your track:\n` +
      `✅ 65 expert-written lessons\n` +
      `✅ Daily AI feedback on your tasks\n` +
      `✅ Monday–Friday delivery (weekends = rest)\n` +
      `✅ Streak tracking to keep you accountable\n\n` +
      `To activate your subscription pay here:\n\n` +
      `Monthly — ₦5,000/month:\n${monthlyLink}\n\n` +
      `Full plan — ₦${fullPrice}:\n${fullLink}\n\n` +
      `Make sure to enter this WhatsApp number in the payment form.\n\n` +
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
      const track = subscriber.track || 'copywriting';
      const isCW2  = track === 'content_writing';
      const isSMM2 = track === 'social_media_management';

      const monthlyLink2 = isCW2  ? 'https://paystack.shop/pay/01d0empofc'
                         : isSMM2 ? 'https://paystack.shop/pay/ec2kdwv0ku'
                         : process.env.PAYSTACK_PAYMENT_LINK;

      const fullLink2 = isCW2  ? 'https://paystack.shop/pay/6gz2f87ft4'
                      : isSMM2 ? 'https://paystack.shop/pay/ok8zxwq28f'
                      : 'https://paystack.shop/pay/m0m9ofipj4';

      const fullPrice2 = isSMM2 ? '9,000 for 60 days (save 1,000)' : '13,000 for 90 days (save 2,000)';

      await sendTextMessage(
        phone,
        `To activate your subscription pay here:\n\n` +
        `Monthly — ₦5,000/month:\n${monthlyLink2}\n\n` +
        `Full plan — ₦${fullPrice2}:\n${fullLink2}\n\n` +
        `Make sure to enter this WhatsApp number in the payment form.`
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

  if (lowerText === 'lesson' || lowerText === 'send lesson') {
    await deliverFullLesson(phone, subscriber);
    return;
  }

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

  if (subscriber.template_sent && !subscriber.lesson_delivered_at) {
    await deliverFullLesson(phone, subscriber);
    await upsertSubscriber(phone, { template_sent: false });
    return;
  }

  if (subscriber.awaiting_task && text.length > 20) {
    const lessonNum = subscriber.current_lesson || 1;
    const track = subscriber.track || 'copywriting';
    const lesson = await getLesson(lessonNum, track);

    await sendTextMessage(phone, `⏳ Analysing your submission...`);

    const feedback = await getAIFeedback(
      lesson?.title || `Day ${lessonNum}`,
      lesson?.task || 'Complete the task',
      text,
      lesson?.feedback_prompt || null
    );

    await sendTextMessage(phone, `🤖 *AI Feedback on Your Task:*\n\n${feedback}`);

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

  if (subscriber.template_sent) {
    await deliverFullLesson(phone, subscriber);
    await upsertSubscriber(phone, { template_sent: false });
    return;
  }
}

// ─────────────────────────────────────────────
// WEBHOOK ROUTES
// ─────────────────────────────────────────────

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry    = req.body?.entry?.[0];
    const change   = entry?.changes?.[0];
    const value    = change?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;
    const msg  = messages[0];
    const from = msg.from;
    const type = msg.type;
    let messageText = '';
    if (type === 'text') {
      messageText = msg.text?.body || '';
    } else if (type === 'interactive') {
      messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else {
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
          lesson_delivered_at: null,
        });
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[ERR] Cron send to ${sub.phone}:`, err.message);
      }
    }
    console.log(`[CRON] lesson_ready template sent to ${subscribers.length} subscribers`);
  } catch (err) {
    console.error('[ERR] Cron job:', err);
  }
}, { timezone: 'Africa/Lagos' });

cron.schedule('0 10 * * 6', async () => {
  console.log('[CRON] Saturday review running...');
  try {
    const { data: subscribers } = await supabase.from('subscribers').select('*').eq('status', 'active');
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
}, { timezone: 'Africa/Lagos' });

cron.schedule('0 11 * * 3', async () => {
  console.log('[CRON] Re-engagement check running...');
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: subscribers } = await supabase
      .from('subscribers').select('*').eq('status', 'active').lt('last_active', threeDaysAgo);
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
}, { timezone: 'Africa/Lagos' });

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'SkillStack NG', timestamp: new Date().toISOString(), uptime: process.uptime() });
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
  console.log(`Template: ${LESSON_READY_TEMPLATE}`);
  console.log(`Cron jobs: Mon-Fri 7am WAT (lessons), Sat 10am WAT (review), Wed 11am WAT (re-engagement)`);
});
