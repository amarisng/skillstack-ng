const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const path = require('path');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';

async function sendMessage(to, body) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to: 'whatsapp:' + to,
      body: body,
    });
    console.log('Sent to ' + to);
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

async function getSubscriber(phone) {
  const { data } = await supabase
    .from('subscribers')
    .select('*')
    .eq('phone', phone)
    .single();
  return data;
}

async function getLesson(lessonNumber) {
  const { data } = await supabase
    .from('lessons')
    .select('*')
    .eq('lesson_number', lessonNumber)
    .eq('track', 'copywriting')
    .single();
  return data;
}

async function getFeedback(task, submission, feedbackPrompt) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: feedbackPrompt + '\n\nLesson task: ' + task + '\n\nStudent submission: ' + submission
    }],
  });
  return message.content[0].text;
}

function formatLesson(lesson, dayNumber) {
  return 'Day ' + dayNumber + ' of 90 - SkillStack NG\n\n' + lesson.title + '\n\n' + lesson.content + '\n\n---\nTODAYS TASK\n' + lesson.task + '\n\nReply with your answer and I will give you personal feedback.';
}

async function handleOnboarding(phone, message) {
  const sub = await getSubscriber(phone);

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
    await sendMessage(phone, 'Welcome to SkillStack NG! Learn copywriting in 90 days - 15 minutes a day, Monday to Friday. No app needed. Reply 1 to get started.');
    return;
  }

  if (sub.active === 'false' && sub.name === '' && message === '1') {
    await sendMessage(phone, 'Perfect choice. Copywriting earns Nigerian freelancers 150k-500k per month. What is your first name?');
    await supabase.from('subscribers').update({ name: 'AWAITING' }).eq('phone', phone);
    return;
  }

  if (sub.active === 'false' && sub.name === 'AWAITING') {
    const name = message.trim();
    await supabase.from('subscribers').update({ name: name }).eq('phone', phone);
    await sendMessage(phone, 'Nice to meet you ' + name + '! What time do you want your daily lesson? Reply: 6AM, 7AM, 8AM, 12PM, 6PM or 9PM');
    return;
  }

  const validTimes = ['6AM', '7AM', '8AM', '12PM', '6PM', '9PM'];
  if (sub.active === 'false' && sub.name !== '' && sub.name !== 'AWAITING' && validTimes.includes(message.toUpperCase())) {
    const timeMap = {
      '6AM': '06:00', '7AM': '07:00', '8AM': '08:00',
      '12PM': '12:00', '6PM': '18:00', '9PM': '21:00'
    };
    const timePreference = timeMap[message.toUpperCase()];
    await supabase.from('subscribers').update({ time_preference: timePreference }).eq('phone', phone);
    await sendMessage(phone, 'Set! Your lesson arrives Monday to Friday at ' + message.toUpperCase() + '. Weekends are practice days. To activate pay 5000 per month here: ' + PAYSTACK_LINK + ' Once paid reply DONE');
    return;
  }

  if (sub.active === 'false' && message.toUpperCase() === 'DONE') {
    await supabase.from('subscribers').update({
      active: 'true',
      day_number: 1,
      streak: 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', phone);
    const lesson = await getLesson(1);
    if (lesson) {
      await sendMessage(phone, 'Payment confirmed! Welcome to SkillStack NG ' + sub.name + '. Your 90 day copywriting journey starts NOW. Here is Day 1:');
      await sendMessage(phone, formatLesson(lesson, 1));
    }
    return;
  }

  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number);
    if (!lesson) {
      await sendMessage(phone, 'You have completed all available lessons. More coming soon!');
      return;
    }
    if (message.toUpperCase() === 'CONTINUE') {
      await sendMessage(phone, formatLesson(lesson, sub.day_number));
      return;
    }
    const feedback = await getFeedback(lesson.task, message, lesson.feedback_prompt);
    await sendMessage(phone, 'Feedback on Day ' + sub.day_number + ':\n\n' + feedback + '\n\nStreak: ' + sub.streak + ' days. See you Monday!');
    const nextDay = sub.day_number < 65 ? sub.day_number + 1 : sub.day_number;
    await supabase.from('subscribers').update({
      day_number: nextDay,
      streak: sub.streak + 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', phone);
    return;
  }

  await sendMessage(phone, 'Welcome back! Reply 1 to start your copywriting journey or DONE if you have already paid.');
}

// Meta WhatsApp webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Meta WhatsApp incoming messages
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry && body.entry[0];
      const changes = entry && entry.changes && entry.changes[0];
      const value = changes && changes.value;
      const messages = value && value.messages;
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const text = msg.text && msg.text.body;
        if (from && text) {
          console.log('Meta message from ' + from + ': ' + text);
          await handleOnboarding(from, text);
        }
      }
    } else {
      // Twilio fallback
      const message = (req.body.Body || '').trim();
      const from = (req.body.From || '').replace('whatsapp:', '');
      if (from && message) {
        console.log('Twilio message from ' + from + ': ' + message);
        await handleOnboarding(from, message);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

cron.schedule('0 * * * *', async () => {
  console.log('Running hourly lesson check...');
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  if (currentMinute > 5) return;
  const watDay = new Date(now.getTime() + 60 * 60 * 1000).getDay();
  if (watDay === 0 || watDay === 6) {
    console.log('Weekend — no lessons today.');
    return;
  }
  const watHour = (currentHour + 1) % 24;
  const timeString = String(watHour).padStart(2, '0') + ':00';
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
    console.log('Sent lesson ' + sub.day_number + ' to ' + sub.phone);
  }
});

cron.schedule('0 8 * * 6', async () => {
  console.log('Sending Saturday review message...');
  const { data: subscribers } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true');
  if (!subscribers) return;
  for (const sub of subscribers) {
    await sendMessage(sub.phone, 'Weekend review time! No new lesson today ' + sub.name + ' — pick your favourite task from this week and rewrite it. Your lessons resume Monday. Keep going!');
  }
});

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
    const now = new Date();
    const watDay = new Date(now.getTime() + 60 * 60 * 1000).getDay();
    if (watDay === 0 || watDay === 6) continue;
    await sendMessage(sub.phone, 'Hey ' + sub.name + '! You missed yesterday\'s lesson Day ' + sub.day_number + '. Your streak is at ' + sub.streak + ' days. Reply CONTINUE and I will send yesterday\'s lesson now.');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('SkillStack NG running on port ' + PORT);
});
