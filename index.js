const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.urlencoded({ extended: false }));

// Raw body needed for Paystack webhook verification
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

const PAYSTACK_LINK = process.env.PAYSTACK_PAYMENT_LINK;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';
const META_TOKEN = process.env.META_WHATSAPP_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_NUMBER_ID;

async function sendMessage(to, body) {
  try {
    // Clean the number — remove any + or spaces
    const cleanNumber = to.replace(/\D/g, '');
    await axios.post(
      'https://graph.facebook.com/v19.0/' + META_PHONE_ID + '/messages',
      {
        messaging_product: 'whatsapp',
        to: cleanNumber,
        type: 'text',
        text: { body: body }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + META_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Sent to ' + cleanNumber);
  } catch (err) {
    console.error('Send error:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

async function sendLessonReadyTemplate(to) {
  try {
    const cleanNumber = to.replace(/\D/g, '');
    await axios.post(
      'https://graph.facebook.com/v19.0/' + META_PHONE_ID + '/messages',
      {
        messaging_product: 'whatsapp',
        to: cleanNumber,
        type: 'template',
        template: {
          name: 'lesson_ready',
          language: { code: 'en' }
        }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + META_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Sent lesson_ready template to ' + cleanNumber);
  } catch (err) {
    console.error('Template send error:', err.response ? JSON.stringify(err.response.data) : err.message);
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

async function activateSubscriber(whatsappNumber, name) {
  try {
    const cleanPhone = whatsappNumber.replace(/\D/g, '');

    // Check if subscriber exists
    let sub = await getSubscriber(cleanPhone);

    if (sub) {
      // Update existing subscriber to active
      await supabase.from('subscribers').update({
        active: 'true',
        day_number: 1,
        streak: 1,
        last_active: new Date().toISOString().split('T')[0]
      }).eq('phone', cleanPhone);
    } else {
      // Create new subscriber
      await supabase.from('subscribers').insert({
        phone: cleanPhone,
        name: name || 'Subscriber',
        day_number: 1,
        track: 'copywriting',
        time_preference: '07:00',
        active: 'true',
        streak: 1,
        last_active: new Date().toISOString().split('T')[0]
      });
    }

    // Send welcome and Day 1 lesson
    const lesson = await getLesson(1);
    if (lesson) {
      await sendMessage(cleanPhone, 'Payment confirmed! Welcome to SkillStack NG ' + (name || '') + '. Your 90 day copywriting journey starts NOW. Here is Day 1:');
      await sendMessage(cleanPhone, formatLesson(lesson, 1));
    }

    console.log('Activated subscriber: ' + cleanPhone);
  } catch (err) {
    console.error('Activation error:', err.message);
  }
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
    await sendMessage(phone, 'Perfect ' + sub.name + '! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '.\n\nTo activate your subscription pay ₦5,000 per month here:\n' + PAYSTACK_LINK + '\n\nMake sure to enter this WhatsApp number (' + phone + ') in the WhatsApp Number field on the payment form so we can activate your account automatically after payment.');
    return;
  }

  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number);
    if (!lesson) {
      await sendMessage(phone, 'You have completed all available lessons. More coming soon!');
      return;
    }
    if (message.toUpperCase() === 'LESSON' || message.toUpperCase() === 'HI' || message.toUpperCase() === 'HELLO' || message.toUpperCase() === 'YES') {
      await sendMessage(phone, formatLesson(lesson, sub.day_number));
      return;
    }
    if (message.toUpperCase() === 'CONTINUE') {
      await sendMessage(phone, formatLesson(lesson, sub.day_number));
      return;
    }
    const feedback = await getFeedback(lesson.task, message, lesson.feedback_prompt);
    await sendMessage(phone, 'Feedback on Day ' + sub.day_number + ':\n\n' + feedback + '\n\nStreak: ' + sub.streak + ' days. See you next lesson!');
    const nextDay = sub.day_number < 65 ? sub.day_number + 1 : sub.day_number;
    await supabase.from('subscribers').update({
      day_number: nextDay,
      streak: sub.streak + 1,
      last_active: new Date().toISOString().split('T')[0]
    }).eq('phone', phone);
    return;
  }

  if (sub.active === 'false') {
    await sendMessage(phone, 'To activate your subscription pay ₦5,000 per month here:\n' + PAYSTACK_LINK + '\n\nMake sure to enter your WhatsApp number in the WhatsApp Number field on the payment form.');
    return;
  }

  await sendMessage(phone, 'Welcome back! Reply 1 to start your copywriting journey.');
}

// Paystack webhook — payment verification
app.post('/paystack-webhook', async (req, res) => {
  try {
    // Verify the webhook is from Paystack
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.log('Invalid Paystack signature');
      return res.status(401).send('Unauthorized');
    }

    const event = JSON.parse(req.body);
    console.log('Paystack event:', event.event);

    if (event.event === 'charge.success' || event.event === 'subscription.create') {
      const data = event.data;
      const customerName = data.customer && data.customer.first_name
        ? data.customer.first_name
        : 'Subscriber';

      // Get WhatsApp number from custom fields
      let whatsappNumber = null;
      if (data.metadata && data.metadata.custom_fields) {
        const whatsappField = data.metadata.custom_fields.find(
          f => f.variable_name === 'whatsapp_number' ||
               f.display_name === 'WhatsApp Number' ||
               f.variable_name === 'whatsapp'
        );
        if (whatsappField) {
          whatsappNumber = whatsappField.value;
        }
      }

      // Also check customer phone
      if (!whatsappNumber && data.customer && data.customer.phone) {
        whatsappNumber = data.customer.phone;
      }

      if (whatsappNumber) {
        console.log('Activating subscriber: ' + whatsappNumber);
        await activateSubscriber(whatsappNumber, customerName);
      } else {
        console.log('No WhatsApp number found in payment data');
        console.log('Payment data:', JSON.stringify(data));
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Paystack webhook error:', err.message);
    res.status(200).send('OK');
  }
});

// Meta webhook verification
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

// Meta incoming messages
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
          console.log('Message from ' + from + ': ' + text);
          await handleOnboarding(from, text);
        }
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
    await sendLessonReadyTemplate(sub.phone);
    console.log('Sent lesson_ready template to ' + sub.phone);
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
    await sendLessonReadyTemplate(sub.phone);
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
    await sendLessonReadyTemplate(sub.phone);
  }
});

app.get('/privacy', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>SkillStack NG Privacy Policy</title><style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}h1{color:#075E54}h2{color:#128C7E;margin-top:32px}</style></head><body><h1>SkillStack NG Privacy Policy</h1><p>Last updated: August 2026</p><h2>Information We Collect</h2><p>We collect your WhatsApp phone number and name when you subscribe to SkillStack NG. We also store your lesson progress and streak data to deliver your daily lessons.</p><h2>How We Use Your Information</h2><p>Your phone number is used solely to deliver your daily copywriting lessons and AI feedback via WhatsApp. We do not sell, share, or use your data for advertising purposes.</p><h2>Data Storage</h2><p>Your data is stored securely on Supabase servers. We retain your data for as long as you are an active subscriber. You may request deletion of your data at any time.</p><h2>WhatsApp Messaging</h2><p>By subscribing to SkillStack NG you consent to receive WhatsApp messages from us including daily lessons, feedback, and account updates. You can unsubscribe at any time by replying STOP.</p><h2>Contact Us</h2><p>For privacy questions contact us at amarissynergylimited@gmail.com</p><p>SkillStack NG is operated by Amaris Synergy Limited, Lagos, Nigeria.</p></body></html>');
});

app.get('/terms', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>SkillStack NG Terms of Service</title><style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}h1{color:#075E54}h2{color:#128C7E;margin-top:32px}</style></head><body><h1>SkillStack NG Terms of Service</h1><p>Last updated: August 2026</p><h2>Service Description</h2><p>SkillStack NG is a WhatsApp-based copywriting education platform operated by Amaris Synergy Limited. Subscribers receive daily copywriting lessons and AI-powered feedback via WhatsApp.</p><h2>Subscription</h2><p>Subscription is billed at 5,000 NGN per month. Payment is processed via Paystack. Your subscription renews automatically each month until cancelled.</p><h2>Cancellation</h2><p>You may cancel your subscription at any time by contacting us at amarissynergylimited@gmail.com. Refunds are not provided for partial months.</p><h2>Content</h2><p>All lesson content is the intellectual property of Amaris Synergy Limited. Subscribers may not reproduce or distribute lesson content without permission.</p><h2>Limitation of Liability</h2><p>SkillStack NG provides educational content only. We do not guarantee specific income outcomes from completing the programme.</p><h2>Contact</h2><p>amarissynergylimited@gmail.com</p></body></html>');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('SkillStack NG running on port ' + PORT);
});
