const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const PAYSTACK_LINK = process.env.PAYSTACK_PAYMENT_LINK;

// ── Send WhatsApp message ─────────────────────────────────────────
async function sendMessage(to, body) {
  try {
    await twilioClient.messages.create({
  from: TWILIO_NUMBER,
  to: `whatsapp:${to}`,
  body: body,
  messagingServiceSid: process.env.TWILIO_MESSAGING_SID || undefined,
    });
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

// ── Get subscriber ────────────────────────────────────────────────
async function getSubscriber(phone) {
  const { data } = await supabase
    .from('subscribers')
    .select('*')
    .eq('phone', phone)
    .single();
  return data;
}

// ── Get lesson ────────────────────────────────────────────────────
async function getLesson(lessonNumber) {
  const { data } = await supabase
    .from('lessons')
    .select('*')
    .eq('lesson_number', lessonNumber)
    .eq('track', 'copywriting')
    .single();
  return data;
}

// ── Claude feedback ───────────────────────────────────────────────
async function getFeedback(task, submission, feedbackPrompt) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `${feedbackPrompt}\n\nLesson task: ${task}\n\nStudent submission: ${submission}`
    }],
  });
  return message.content[0].text;
}

// ── Format lesson for WhatsApp ────────────────────────────────────
function formatLesson(lesson, dayNumber) {
  return `📚 *Day ${dayNumber} of 90* — SkillStack NG\n\n*${lesson.title}*\n\n${lesson.content}\n\n---\n\n✏️ *TODAY'S TASK*\n${lesson.task}\n\n_Reply with your answer and I will give you personal feedback._`;
}

// ── Onboarding flow ───────────────────────────────────────────────
async function handleOnboarding(phone, message) {
  const sub = await getSubscriber(phone);

  // Brand new user
  if (!sub) {
    await supabase.from('subscribers').insert({
      phone: phone,
      name: '',
      day_number: 0,
      track: 'copywriting',
      time_preference: '07:00',
      active: 'false',
      streak: 0,
    });

    await sendMessage(phone,
      `Welcome to *SkillStack NG* 🎯\n\nYou are about to learn one high-income skill in 90 days — 15 minutes a day, no video buffering, no overwhelm.\n\nI have one track open right now:\n\n1️⃣ Copywriting & Persuasion\n\nThis skill earns Nigerian freelancers ₦150,000–₦500,000 per month writing for brands and digital products.\n\nReply *1* to get started.`
    );
    return;
  }

  // User replied 1 — ask for name
  if (sub.active === 'false' && sub.name === '' && message === '1') {
    await sendMessage(phone,
      `Perfect choice. Copywriting is the #1 skill Nigerian freelancers use to earn from home.\n\nWhat is your first name?`
    );
    await supabase.from('subscribers').update({ name: 'AWAITING' }).eq('phone', phone);
    return;
  }

  // User sent their name
  if (sub.active === 'false' && sub.name === 'AWAITING') {
    const name = message.trim();
    await supabase.from('subscribers').update({ name: name }).eq('phone', phone);

    await sendMessage(phone,
      `Nice to meet you, ${name}! 🙌\n\nWhat time do you want your daily lesson?\n\nReply with one of these:\n⏰ *6AM*\n⏰ *7AM*\n⏰ *8AM*\n⏰ *12PM*\n⏰ *6PM*\n⏰ *9PM*`
    );
    return;
  }

  // User chose time
  const validTimes = ['6AM', '7AM', '8AM', '12PM', '6PM', '9PM'];
  if (sub.active === 'false' && sub.name !== '' && sub.name !== 'AWAITING' && validTimes.includes(message.toUpperCase())) {
    const timeMap = {
      '6AM': '06:00', '7AM': '07:00', '8AM': '08:00',
      '12PM': '12:00', '6PM': '18:00', '9PM': '21:00'
    };
    const timePreference = timeMap[message.toUpperCase()];
    await supabase.from('subscribers').update({ time_preference: timePreference }).eq('phone', phone);

    await sendMessage(phone,
      `Set! Every day at ${message.toUpperCase()}, your lesson arrives here. 📬\n\nTo activate your subscription and start Day 1:\n\n👉 *Pay ₦3,000/month here:*\n${PAYSTACK_LINK}\n\nOnce you have paid, reply *DONE* and I will set up your first lesson immediately.`
    );
    return;
  }

  // User confirmed payment
  if (sub.active === 'false' && message.toUpperCase() === 'DONE') {
    await supabase.from('subscribers').update({
      active: 'true',
      day_number: 1,
      streak: 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', phone);

    const lesson = await getLesson(1);
    if (lesson) {
      await sendMessage(phone,
        `Payment confirmed! Welcome to SkillStack NG, ${sub.name}. 🚀\n\nYour 90-day copywriting journey starts NOW.\n\nHere is Day 1:`
      );
      await sendMessage(phone, formatLesson(lesson, 1));
    }
    return;
  }

  // Active subscriber sent a task submission
  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number);
    if (!lesson) {
      await sendMessage(phone, `You have completed all available lessons. More coming soon! 🎉`);
      return;
    }

    // Check for CONTINUE command (missed day re-engagement)
    if (message.toUpperCase() === 'CONTINUE') {
      await sendMessage(phone, formatLesson(lesson, sub.day_number));
      return;
    }

    // Get Claude feedback on task submission
    const feedback = await getFeedback(lesson.task, message, lesson.feedback_prompt);

    await sendMessage(phone,
      `📝 *Feedback on Day ${sub.day_number}:*\n\n${feedback}\n\n---\n🎯 Streak: ${sub.streak} day${sub.streak !== 1 ? 's' : ''} 🔥\n\nSee you tomorrow at ${sub.time_preference === '06:00' ? '6AM' : sub.time_preference === '07:00' ? '7AM' : sub.time_preference === '08:00' ? '8AM' : sub.time_preference === '12:00' ? '12PM' : sub.time_preference === '18:00' ? '6PM' : '9PM'}!`
    );

    // Advance to next day
    const nextDay = sub.day_number < 14 ? sub.day_number + 1 : sub.day_number;
    await supabase.from('subscribers').update({
      day_number: nextDay,
      streak: sub.streak + 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', phone);
    return;
  }

  // Fallback
  await sendMessage(phone,
    `Welcome back! 👋\n\nReply *1* to start your copywriting journey or *DONE* if you have already paid.`
  );
}

// ── Webhook endpoint ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  const message = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:', '');

  if (!from || !message) return;

  console.log(`Message from ${from}: ${message}`);
  await handleOnboarding(from, message);
});

// ── Daily lesson scheduler ────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('Running hourly lesson check...');

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  if (currentMinute > 5) return;

  // WAT is UTC+1
  const watHour = (currentHour + 1) % 24;
  const timeString = `${String(watHour).padStart(2, '0')}:00`;

  const { data: subscribers } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true')
    .eq('time_preference', timeString);

  if (!subscribers || subscribers.length === 0) return;

  const today = new Date().toISOString().split('T')[0];

  for (const sub of subscribers) {
    if (sub.last_active === today) continue;

    const lesson = await getLesson(sub.day_number);
    if (!lesson) continue;

    await sendMessage(sub.phone, formatLesson(lesson, sub.day_number));
    console.log(`Sent lesson ${sub.day_number} to ${sub.phone}`);
  }
});

// ── Re-engagement scheduler (runs daily at 10am WAT) ─────────────
cron.schedule('0 9 * * *', async () => {
  console.log('Running re-engagement check...');

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const { data: missedSubscribers } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true')
    .eq('last_active', yesterdayStr);

  if (!missedSubscribers) return;

  for (const sub of missedSubscribers) {
    await sendMessage(sub.phone,
      `Hey ${sub.name} 👋\n\nYou missed yesterday's lesson (Day ${sub.day_number}).\n\nYour streak is at *${sub.streak} days* — don't let it go.\n\nReply *CONTINUE* and I will send yesterday's lesson right now.`
    );
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('SkillStack NG bot is running 🚀');
});

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SkillStack NG running on port ${PORT}`);
});
