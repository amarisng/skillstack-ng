const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use('/paystack-webhook', express.raw({ type: 'application/json' }));
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
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_TEST_SECRET = process.env.PAYSTACK_TEST_SECRET_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';

async function sendMessage(to, body) {
  try {
    const cleanNumber = to.replace(/\D/g, '');
    const formattedTo = 'whatsapp:+' + cleanNumber;
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to: formattedTo,
      body: body,
    });
    console.log('Sent to ' + cleanNumber);
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

async function getSubscriber(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  const { data } = await supabase
    .from('subscribers')
    .select('*')
    .eq('phone', cleanPhone)
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

async function activateSubscriber(whatsappNumber, name, planType = 'monthly') {
  try {
    const cleanPhone = whatsappNumber.replace(/\D/g, '');
    let finalPhone = cleanPhone;
    if (finalPhone.startsWith('0')) {
      finalPhone = '234' + finalPhone.substring(1);
    }

    console.log('Activating subscriber: ' + finalPhone);
    let sub = await getSubscriber(finalPhone);

    if (sub) {
      if (sub.active === 'true') {
        console.log('Subscriber already active — skipping duplicate: ' + finalPhone);
        return;
      }
      await supabase.from('subscribers').update({
        active: 'true',
        day_number: 1,
        streak: 1,
        plan_type: planType,
        last_active: new Date().toISOString().split('T')[0]
      }).eq('phone', finalPhone);
    } else {
      await supabase.from('subscribers').insert({
        phone: finalPhone,
        name: name || 'Subscriber',
        day_number: 1,
        track: 'copywriting',
        time_preference: '07:00',
        active: 'true',
        streak: 1,
        plan_type: planType,
        last_active: new Date().toISOString().split('T')[0]
      });
    }

    const planMsg = planType === 'full'
      ? 'Payment confirmed! Welcome to SkillStack NG ' + (name || '') + '. Your full 90-day copywriting journey is unlocked - no monthly renewals needed.'
      : 'Payment confirmed! Welcome to SkillStack NG ' + (name || '') + '. Your 90-day copywriting journey starts NOW.';
    await sendMessage(finalPhone, planMsg);
    await sendMessage(finalPhone, 'One quick question — what time do you want your daily lesson delivered to this WhatsApp?\n\nReply with your preferred time:\n6AM\n7AM\n8AM\n12PM\n6PM\n9PM');

    console.log('Subscriber activated successfully: ' + finalPhone);
  } catch (err) {
    console.error('Activation error:', err.message);
  }
}

async function handleOnboarding(phone, message) {
  const cleanPhone = phone.replace(/\D/g, '');
  const sub = await getSubscriber(cleanPhone);

  if (!sub) {
    await supabase.from('subscribers').insert({
      phone: cleanPhone,
      name: '',
      day_number: 0,
      track: 'copywriting',
      time_preference: '07:00',
      active: 'false',
      streak: 0,
    });
    await sendMessage(cleanPhone, 'Welcome to SkillStack NG! Learn copywriting in 90 days - 15 minutes a day, Monday to Friday. No app needed. Reply 1 to get started.');
    return;
  }

  if (sub.active === 'false' && sub.name === '' && message === '1') {
    await sendMessage(cleanPhone, 'Perfect choice. Copywriting earns Nigerian freelancers 150k-500k per month. What is your first name?');
    await supabase.from('subscribers').update({ name: 'AWAITING' }).eq('phone', cleanPhone);
    return;
  }

  if (sub.active === 'false' && sub.name === 'AWAITING') {
    const name = message.trim();
    await supabase.from('subscribers').update({ name: name }).eq('phone', cleanPhone);
    await sendMessage(cleanPhone, 'Nice to meet you ' + name + '! What time do you want your daily lesson? Reply: 6AM, 7AM, 8AM, 12PM, 6PM or 9PM');
    return;
  }

  const validTimes = ['6AM', '7AM', '8AM', '12PM', '6PM', '9PM'];
  if (sub.active === 'false' && sub.name !== '' && sub.name !== 'AWAITING' && validTimes.includes(message.toUpperCase())) {
    const timeMap = {
      '6AM': '06:00', '7AM': '07:00', '8AM': '08:00',
      '12PM': '12:00', '6PM': '18:00', '9PM': '21:00'
    };
    const timePreference = timeMap[message.toUpperCase()];
    await supabase.from('subscribers').update({ time_preference: timePreference }).eq('phone', cleanPhone);
    await sendMessage(cleanPhone, 'Perfect ' + sub.name + '! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '.\n\nTo activate your subscription pay here:\n\nMonthly - 5,000/month: ' + PAYSTACK_LINK + '\n\nFull 90 days - 13,000 (save 2,000): https://paystack.shop/pay/m0m9ofipj4\n\nMake sure to enter this WhatsApp number in the payment form.');
    return;
  }

  // Handle time preference reply from newly activated subscribers
  const validTimes2 = ['6AM', '7AM', '8AM', '12PM', '6PM', '9PM'];
  if (sub.active === 'true' && sub.day_number === 1 && validTimes2.includes(message.toUpperCase())) {
    const timeMap2 = {
      '6AM': '06:00', '7AM': '07:00', '8AM': '08:00',
      '12PM': '12:00', '6PM': '18:00', '9PM': '21:00'
    };
    const timePreference = timeMap2[message.toUpperCase()];
    await supabase.from('subscribers').update({
      time_preference: timePreference,
      last_active: new Date(Date.now() - 86400000).toISOString().split('T')[0]
    }).eq('phone', cleanPhone);
    const lesson = await getLesson(1);
    await sendMessage(cleanPhone, 'Perfect! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '. Here is your Day 1 lesson right now:');
    if (lesson) await sendMessage(cleanPhone, formatLesson(lesson, 1));
    return;
  }

  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number);
    if (!lesson) {
      await sendMessage(cleanPhone, 'You have completed all available lessons. More coming soon!');
      return;
    }
    if (message.toUpperCase() === 'LESSON' || message.toUpperCase() === 'HI' || message.toUpperCase() === 'HELLO' || message.toUpperCase() === 'YES' || message.toUpperCase() === 'CONTINUE') {
      await sendMessage(cleanPhone, formatLesson(lesson, sub.day_number));
      return;
    }
    const wordCount = message.trim().split(/\s+/).length;
    if (wordCount < 5) {
      await sendMessage(cleanPhone, 'Welcome back! Here is your Day ' + sub.day_number + ' lesson:');
      await sendMessage(cleanPhone, formatLesson(lesson, sub.day_number));
      return;
    }
    const feedback = await getFeedback(lesson.task, message, lesson.feedback_prompt);
    await sendMessage(cleanPhone, 'Feedback on Day ' + sub.day_number + ':\n\n' + feedback + '\n\nStreak: ' + (sub.streak + 1) + ' days. Keep going!');
    const nextDay = sub.day_number < 65 ? sub.day_number + 1 : sub.day_number;
    await supabase.from('subscribers').update({
      day_number: nextDay,
      streak: sub.streak + 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', cleanPhone);
    return;
  }

  if (sub.active === 'false') {
    await sendMessage(cleanPhone, 'To activate your subscription pay here:\n\nMonthly - 5,000/month: ' + PAYSTACK_LINK + '\n\nFull 90 days - 13,000 (save 2,000): https://paystack.shop/pay/m0m9ofipj4');
    return;
  }

  await sendMessage(cleanPhone, 'Welcome back! Reply 1 to start your copywriting journey.');
}

app.post('/paystack-webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const hashLive = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body).digest('hex');
    const hashTest = PAYSTACK_TEST_SECRET
      ? crypto.createHmac('sha512', PAYSTACK_TEST_SECRET)
          .update(req.body).digest('hex')
      : null;

    if (hashLive !== signature && hashTest !== signature) {
      console.log('Invalid Paystack signature');
      return res.status(401).send('Unauthorized');
    }

    const event = JSON.parse(req.body);
    console.log('Paystack event received:', event.event);

    if (event.event === 'charge.success') {
      const data = event.data;
      const customerName = data.customer && data.customer.first_name
        ? data.customer.first_name : 'Subscriber';

      let whatsappNumber = null;
      if (data.metadata && data.metadata.custom_fields) {
        const whatsappField = data.metadata.custom_fields.find(
          f => f.variable_name === 'whatsapp_number' ||
               f.display_name === 'WhatsApp Number' ||
               f.variable_name === 'whatsapp' ||
               f.display_name === 'whatsapp_number'
        );
        if (whatsappField) {
          whatsappNumber = whatsappField.value;
          console.log('WhatsApp number from custom field: ' + whatsappNumber);
        }
      }

      if (whatsappNumber) {
        const amount = data.amount / 100;
        const planType = amount >= 13000 ? 'full' : 'monthly';
        await activateSubscriber(whatsappNumber, customerName, planType);
      } else {
        console.log('No WhatsApp number found. Metadata: ' + JSON.stringify(data.metadata));
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Paystack webhook error:', err.message);
    res.status(200).send('OK');
  }
});

// Meta webhook verification (kept for backup)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Twilio incoming messages
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const message = (req.body.Body || '').trim();
    const from = (req.body.From || '').replace('whatsapp:+', '');
    if (!from || !message) return;
    console.log('Message from ' + from + ': ' + message);
    await handleOnboarding(from, message);
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
  const watNow = new Date(now.getTime() + 60 * 60 * 1000);
  const watDay = watNow.getDay();
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
    if (!lesson) {
      console.log('No lesson found for day ' + sub.day_number);
      continue;
    }
    await sendMessage(sub.phone, formatLesson(lesson, sub.day_number));
    await supabase.from('subscribers').update({
      last_active: today
    }).eq('phone', sub.phone);
    console.log('Sent Day ' + sub.day_number + ' lesson to ' + sub.phone);
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
    await sendMessage(sub.phone, 'Weekend review time! No new lesson today ' + sub.name + ' — pick your favourite task from this week and rewrite it. See if you can improve it. Your lessons resume Monday. Keep going!');
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
    await sendMessage(sub.phone, 'Hey ' + sub.name + '! You missed yesterday\'s lesson. Reply CONTINUE and I will send it now. Your streak is at ' + sub.streak + ' days — keep it going!');
  }
});

app.get('/privacy', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Privacy Policy</title><style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}h1{color:#075E54}</style></head><body><h1>SkillStack NG Privacy Policy</h1><p>Last updated: August 2026</p><p>We collect your WhatsApp phone number and name to deliver daily lessons. We do not sell your data. Contact: amarissynergylimited@gmail.com</p></body></html>');
});

app.get('/terms', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Terms</title><style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}h1{color:#075E54}</style></head><body><h1>SkillStack NG Terms of Service</h1><p>Last updated: August 2026</p><p>Subscription is billed at 5,000 NGN per month. Cancel anytime by emailing amarissynergylimited@gmail.com.</p></body></html>');
});

app.get('/beta', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'beta.html'));
});

app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

app.get('/thankyou', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thankyou.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('SkillStack NG running on port ' + PORT);
});
