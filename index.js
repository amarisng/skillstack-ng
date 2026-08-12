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

async function getLesson(lessonNumber, track = 'copywriting') {
  const { data } = await supabase
    .from('lessons')
    .select('*')
    .eq('lesson_number', lessonNumber)
    .eq('track', track)
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

    // Set subscription expiry — 95 days for copywriting full, 65 days for SMM full, 32 days for monthly
    const expiryDays = planType === 'full' ? 95 : 32;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + expiryDays);
    const subscriptionExpires = expiryDate.toISOString().split('T')[0];

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
        subscription_expires: subscriptionExpires,
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
        subscription_expires: subscriptionExpires,
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
if (sub && sub.active === 'false' &&
      (message.toUpperCase() === 'RESTART' ||
       message.toUpperCase() === 'CHANGE' ||
       message.toUpperCase() === 'BACK')) {
    await supabase.from('subscribers').update({
      name: '',
      track: 'copywriting',
      time_preference: '07:00',
      day_number: 0
    }).eq('phone', cleanPhone);
    await sendMessage(cleanPhone, 'No problem. Let us start over.\n\nReply 1 for Copywriting or 2 for Social Media Management to get started.');
    return;
  }
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
    await sendMessage(cleanPhone, 'Welcome to SkillStack NG! 🎓\n\nWe deliver high-income skill lessons to your WhatsApp every weekday — 15 minutes a day, AI feedback on every task.\n\nChoose your track:\n\n1️⃣ Copywriting & Persuasion — 90 days\nWrite sales copy, ads, email sequences, and landing pages. Earn ₦100k–₦500k per project.\n\n2️⃣ Social Media Management — 60 days\nManage brand accounts professionally. Earn ₦80k–₦900k per month.\n\nReply 1 for Copywriting or 2 for Social Media Management to get started.');
    return;
  }

  // Handle track selection
  if (sub.active === 'false' && sub.name === '' && (message === '1' || message === '2')) {
    const selectedTrack = message === '1' ? 'copywriting' : 'social_media_management';
    const trackName = message === '1' ? 'Copywriting & Persuasion (90 days)' : 'Social Media Management (60 days)';
    await supabase.from('subscribers').update({ track: selectedTrack, name: 'AWAITING' }).eq('phone', cleanPhone);
    await sendMessage(cleanPhone, 'Great choice! ' + trackName + ' it is.\n\nFirst — what is your first name?');
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
    await supabase.from('subscribers').update({
      time_preference: timePreference,
      name: sub.name + '_CONFIRMING'
    }).eq('phone', cleanPhone);
    const trackLabel = sub.track === 'social_media_management'
      ? 'Social Media Management — 60 days'
      : 'Copywriting & Persuasion — 90 days';
    await sendMessage(cleanPhone, 'Almost done ' + sub.name + '! Just to confirm:\n\n📚 Track: ' + trackLabel + '\n⏰ Time: ' + message.toUpperCase() + '\n\nIs this correct?\n\nReply YES to proceed to payment\nReply BACK to change your track');
    return;
  }
  }

  // Handle time preference reply from newly activated subscribers
if (sub && sub.active === 'false' && sub.name && sub.name.endsWith('_CONFIRMING')) {
    const realName = sub.name.replace('_CONFIRMING', '');
    if (message.toUpperCase() === 'YES') {
      await supabase.from('subscribers').update({ name: realName }).eq('phone', cleanPhone);
      const isSMM = sub.track === 'social_media_management';
      const monthlyLink = isSMM ? 'https://paystack.shop/pay/ec2kdwv0ku' : PAYSTACK_LINK;
      const fullLink = isSMM ? 'https://paystack.shop/pay/ok8zxwq28f' : 'https://paystack.shop/pay/m0m9ofipj4';
      const fullPrice = isSMM ? '9,000 for 60 days (save 1,000)' : '13,000 for 90 days (save 2,000)';
      await sendMessage(cleanPhone, 'Perfect ' + realName + '! Your lesson will arrive Monday to Friday at your chosen time.\n\nTo activate your subscription pay here:\n\nMonthly — ₦5,000/month:\n' + monthlyLink + '\n\nFull plan — ₦' + fullPrice + ':\n' + fullLink + '\n\nMake sure to enter this WhatsApp number (' + cleanPhone + ') in the payment form.');
    } else if (message.toUpperCase() === 'BACK' || message.toUpperCase() === 'CHANGE') {
      await supabase.from('subscribers').update({ name: realName, track: 'copywriting' }).eq('phone', cleanPhone);
      await sendMessage(cleanPhone, 'No problem. Which track do you want?\n\n1️⃣ Copywriting & Persuasion — 90 days. Earn ₦100k–₦500k per project.\n2️⃣ Social Media Management — 60 days. Earn ₦80k–₦900k per month.\n\nReply 1 or 2.');
    } else {
      await sendMessage(cleanPhone, 'Please reply YES to confirm or BACK to change your track.');
    }
    return;
  }
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
    const lesson = await getLesson(1, sub.track || 'copywriting');
    await sendMessage(cleanPhone, 'Perfect! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '. Here is your Day 1 lesson right now:');
    if (lesson) await sendMessage(cleanPhone, formatLesson(lesson, 1));
    return;
  }

  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number, sub.track || 'copywriting');
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
    const isSMM = sub.track === 'social_media_management';
    const monthlyLink = isSMM ? 'https://paystack.shop/pay/ec2kdwv0ku' : PAYSTACK_LINK;
    const fullLink = isSMM ? 'https://paystack.shop/pay/ok8zxwq28f' : 'https://paystack.shop/pay/m0m9ofipj4';
    const fullPrice = isSMM ? '9,000 for 60 days' : '13,000 for 90 days';
    await sendMessage(cleanPhone, 'To activate your subscription pay here:\n\nMonthly — ₦5,000/month:\n' + monthlyLink + '\n\nFull plan — ₦' + fullPrice + ':\n' + fullLink);
    return;
  }

  await sendMessage(cleanPhone, 'Welcome back! Reply 1 for Copywriting or 2 for Social Media Management to get started.');
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
        let planType = 'monthly';
        if (amount >= 13000) planType = 'full'; // Copywriting full 90 days
        else if (amount >= 9000) planType = 'full'; // SMM full 60 days
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
    const lesson = await getLesson(sub.day_number, sub.track || 'copywriting');
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

// Daily subscription expiry check — runs at 8AM WAT (7AM UTC)
cron.schedule('0 7 * * *', async () => {
  console.log('Running subscription expiry check...');
  const today = new Date().toISOString().split('T')[0];

  // Find monthly subscribers whose subscription has expired
  const { data: expiredSubs } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true')
    .eq('plan_type', 'monthly')
    .lt('subscription_expires', today);

  if (!expiredSubs || expiredSubs.length === 0) {
    console.log('No expired subscriptions found.');
    return;
  }

  for (const sub of expiredSubs) {
    // Deactivate the subscriber
    await supabase.from('subscribers').update({
      active: 'false'
    }).eq('phone', sub.phone);

    // Send renewal message
    await sendMessage(sub.phone,
      'Hi ' + sub.name + ', your SkillStack NG subscription has expired and your lessons have been paused.\n\n' +
      'To continue your copywriting journey from Day ' + sub.day_number + ', renew here:\n\n' +
      'Monthly - 5,000/month: ' + PAYSTACK_LINK + '\n\n' +
      'Full 90 days - 13,000 (save 2,000): https://paystack.shop/pay/m0m9ofipj4\n\n' +
      'Your progress is saved — you will pick up exactly where you left off.'
    );
    console.log('Deactivated expired subscriber: ' + sub.phone);
  }

  // Also send a 3-day warning to subscribers expiring in 3 days
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
  const warningDate = threeDaysFromNow.toISOString().split('T')[0];

  const { data: expiringSoon } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true')
    .eq('plan_type', 'monthly')
    .eq('subscription_expires', warningDate);

  if (!expiringSoon) return;
  for (const sub of expiringSoon) {
    await sendMessage(sub.phone,
      'Hi ' + sub.name + '! Your SkillStack NG subscription renews in 3 days.\n\n' +
      'If your card details have changed or you would like to switch to the full 90-day plan (save 2,000), update here:\n\n' +
      'Full 90 days - 13,000: https://paystack.shop/pay/m0m9ofipj4\n\n' +
      'Otherwise your monthly renewal will happen automatically. Keep going!'
    );
  }
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Privacy Policy — SkillStack NG</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 24px; line-height: 1.8; color: #1A2E1F; }
    h1 { color: #0D1F17; font-size: 2rem; margin-bottom: 8px; }
    h2 { color: #00C48C; font-size: 1.1rem; margin-top: 36px; margin-bottom: 8px; }
    p { margin-bottom: 14px; color: #3A5A45; }
    ul { margin: 0 0 14px 20px; color: #3A5A45; }
    ul li { margin-bottom: 6px; }
    .meta { font-size: 0.85rem; color: #5A7A65; margin-bottom: 32px; }
    nav { background: #0D1F17; padding: 16px 24px; margin: -40px -24px 40px; }
    nav a { color: #00C48C; text-decoration: none; font-weight: 700; }
    a { color: #00C48C; }
  </style>
</head>
<body>
  <nav><a href="/">← SkillStack NG</a></nav>
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated: August 2026 | Effective date: August 2026</p>

  <p>This Privacy Policy describes how Amaris Synergy Limited ("we", "us", or "our") collects, uses, and protects your personal information when you use SkillStack NG ("the Service"). By subscribing to SkillStack NG you agree to the terms of this Privacy Policy.</p>

  <h2>1. Who We Are</h2>
  <p>SkillStack NG is operated by Amaris Synergy Limited, a company registered in Nigeria. Our registered address is 12 Babatunde Street, Lagos, Nigeria. You can contact us at hello@skillstackng.com.</p>

  <h2>2. Information We Collect</h2>
  <p>We collect the following information when you use SkillStack NG:</p>
  <ul>
    <li><strong>WhatsApp phone number</strong> — collected when you subscribe or interact with our WhatsApp bot. This is the primary identifier for your account.</li>
    <li><strong>Name</strong> — collected during onboarding so we can personalise your lessons.</li>
    <li><strong>Payment information</strong> — we do not store your card details. Payment is processed by Paystack and governed by their privacy policy. We only receive confirmation that a payment was successful and the amount paid.</li>
    <li><strong>Lesson progress data</strong> — including your current day number, streak count, last active date, time preference, and subscription plan type.</li>
    <li><strong>Task submissions</strong> — the text you send as task responses is processed by our AI coach to generate feedback. We do not permanently store your task submissions beyond the active session.</li>
    <li><strong>Device and usage data</strong> — WhatsApp message metadata such as timestamps may be processed as part of normal WhatsApp Business API operations.</li>
  </ul>

  <h2>3. How We Use Your Information</h2>
  <p>We use your personal information solely to:</p>
  <ul>
    <li>Deliver your daily copywriting lessons via WhatsApp</li>
    <li>Generate personalised AI feedback on your task submissions</li>
    <li>Track your learning progress and maintain your streak</li>
    <li>Send you account notifications such as missed lesson reminders and subscription renewal alerts</li>
    <li>Process and verify your subscription payments</li>
    <li>Respond to support requests and enquiries</li>
    <li>Improve the quality and relevance of our lesson content</li>
  </ul>
  <p>We do not use your personal information for advertising, profiling, or any purpose unrelated to delivering our educational service.</p>

  <h2>4. How We Share Your Information</h2>
  <p>We do not sell, rent, or trade your personal information to any third party. We share your information only with the following service providers who help us operate the platform:</p>
  <ul>
    <li><strong>Meta (WhatsApp Business API)</strong> — to deliver messages to your WhatsApp number. Subject to Meta's privacy policy.</li>
    <li><strong>Twilio</strong> — our WhatsApp messaging infrastructure provider. Subject to Twilio's privacy policy.</li>
    <li><strong>Supabase</strong> — our secure database provider where your account data is stored. Subject to Supabase's privacy policy.</li>
    <li><strong>Anthropic</strong> — our AI provider that processes your task submissions to generate feedback. Submissions are processed in real time and not retained by Anthropic beyond the session. Subject to Anthropic's privacy policy.</li>
    <li><strong>Paystack</strong> — our payment processor. Subject to Paystack's privacy policy.</li>
  </ul>
  <p>All third-party providers are contractually required to handle your data securely and only for the purposes we specify.</p>

  <h2>5. Data Storage and Security</h2>
  <p>Your account data is stored on Supabase servers with industry-standard encryption at rest and in transit. We implement appropriate technical and organisational measures to protect your personal information against unauthorised access, alteration, disclosure, or destruction.</p>
  <p>While we take reasonable precautions, no method of transmission over the internet or electronic storage is 100% secure. We cannot guarantee absolute security of your data.</p>

  <h2>6. Data Retention</h2>
  <p>We retain your personal information for as long as your account is active or as needed to provide our service. If you cancel your subscription, we retain your data for 90 days in case you wish to reactivate, after which it is deleted from our active systems. You may request immediate deletion at any time by emailing hello@skillstackng.com.</p>

  <h2>7. Your Rights</h2>
  <p>You have the following rights regarding your personal information:</p>
  <ul>
    <li><strong>Access</strong> — you may request a copy of the personal information we hold about you</li>
    <li><strong>Correction</strong> — you may request that we correct inaccurate information</li>
    <li><strong>Deletion</strong> — you may request that we delete your personal information</li>
    <li><strong>Portability</strong> — you may request your data in a portable format</li>
    <li><strong>Objection</strong> — you may object to certain uses of your data</li>
    <li><strong>Withdrawal of consent</strong> — you may stop receiving WhatsApp messages at any time by replying STOP</li>
  </ul>
  <p>To exercise any of these rights, contact us at hello@skillstackng.com. We will respond within 30 days.</p>

  <h2>8. WhatsApp Messaging</h2>
  <p>By subscribing to SkillStack NG you consent to receive WhatsApp messages from us including daily lessons, task feedback, account notifications, and subscription alerts. Standard WhatsApp data rates may apply depending on your mobile carrier. You may unsubscribe at any time by replying STOP to any message.</p>

  <h2>9. Children's Privacy</h2>
  <p>SkillStack NG is not directed at children under the age of 16. We do not knowingly collect personal information from children under 16. If you believe a child has provided us with personal information, please contact us and we will delete it promptly.</p>

  <h2>10. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of significant changes by sending a WhatsApp message to active subscribers. Your continued use of the Service after changes are posted constitutes your acceptance of the updated policy.</p>

  <h2>11. Contact Us</h2>
  <p>For any privacy-related questions, requests, or complaints, contact us at:</p>
  <p><strong>Amaris Synergy Limited</strong><br/>
  12 Babatunde Street, Lagos, Nigeria<br/>
  Email: hello@skillstackng.com</p>
</body>
</html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Terms of Service — SkillStack NG</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 24px; line-height: 1.8; color: #1A2E1F; }
    h1 { color: #0D1F17; font-size: 2rem; margin-bottom: 8px; }
    h2 { color: #00C48C; font-size: 1.1rem; margin-top: 36px; margin-bottom: 8px; }
    p { margin-bottom: 14px; color: #3A5A45; }
    ul { margin: 0 0 14px 20px; color: #3A5A45; }
    ul li { margin-bottom: 6px; }
    .meta { font-size: 0.85rem; color: #5A7A65; margin-bottom: 32px; }
    nav { background: #0D1F17; padding: 16px 24px; margin: -40px -24px 40px; }
    nav a { color: #00C48C; text-decoration: none; font-weight: 700; }
    a { color: #00C48C; }
  </style>
</head>
<body>
  <nav><a href="/">← SkillStack NG</a></nav>
  <h1>Terms of Service</h1>
  <p class="meta">Last updated: August 2026 | Effective date: August 2026</p>

  <p>These Terms of Service ("Terms") govern your use of SkillStack NG, operated by Amaris Synergy Limited ("we", "us", or "our"). By subscribing to or using SkillStack NG you agree to be bound by these Terms. Please read them carefully.</p>

  <h2>1. About SkillStack NG</h2>
  <p>SkillStack NG is a WhatsApp-based educational platform that delivers daily skill-building lessons to subscribers. Our Copywriting and Persuasion track consists of 65 lessons delivered Monday to Friday over 90 days. Each lesson includes educational content, a practical task, and AI-powered feedback on task submissions.</p>

  <h2>2. Eligibility</h2>
  <p>To use SkillStack NG you must:</p>
  <ul>
    <li>Be at least 16 years of age</li>
    <li>Have a valid WhatsApp account and phone number</li>
    <li>Have the legal capacity to enter into a binding agreement</li>
    <li>Not be prohibited from using our service under applicable law</li>
  </ul>

  <h2>3. Subscription Plans</h2>
  <p>SkillStack NG offers two subscription plans:</p>
  <ul>
    <li><strong>Monthly Plan — ₦5,000/month:</strong> Billed monthly via card. Renews automatically each month until cancelled. Lessons are delivered for the duration of the active subscription period.</li>
    <li><strong>Full 90-Day Plan — ₦13,000 (one-time):</strong> A single payment that grants access to the full 90-day programme. No recurring charges. Bank transfer accepted.</li>
  </ul>
  <p>Prices are subject to change. We will notify active subscribers at least 30 days before any price increase takes effect. Founding member rates are locked in for subscribers who join before the price increase date.</p>

  <h2>4. Payment and Billing</h2>
  <p>All payments are processed securely by Paystack. By subscribing you authorise Paystack to charge your selected payment method for the subscription amount.</p>
  <ul>
    <li>For monthly subscribers, your card will be charged automatically on the same date each month</li>
    <li>If a monthly payment fails, your subscription will be paused and lessons will stop until payment is successfully processed</li>
    <li>You will receive a WhatsApp notification if your payment fails with instructions to renew</li>
    <li>We do not store your card details — all payment information is held securely by Paystack</li>
  </ul>

  <h2>5. Cancellation Policy</h2>
  <p>You may cancel your monthly subscription at any time by emailing hello@skillstackng.com. Upon cancellation:</p>
  <ul>
    <li>Your subscription will remain active until the end of the current billing period</li>
    <li>You will not be charged for the following month</li>
    <li>No partial refunds are provided for unused days in the current billing period</li>
    <li>Your lesson progress is saved for 90 days after cancellation in case you reactivate</li>
  </ul>

  <h2>6. Refund Policy</h2>
  <p>We offer refunds in the following circumstances:</p>
  <ul>
    <li><strong>Technical failure:</strong> If our platform fails to deliver lessons for more than 5 consecutive weekdays due to a technical issue on our end, you are entitled to a pro-rated refund for the affected period</li>
    <li><strong>Duplicate payment:</strong> If you are charged twice for the same subscription period, we will refund the duplicate charge within 5 business days</li>
  </ul>
  <p>We do not offer refunds for change of mind, failure to engage with lessons, or dissatisfaction with lesson content after more than 7 days of access. To request a refund email hello@skillstackng.com with your WhatsApp number and reason.</p>

  <h2>7. Lesson Delivery</h2>
  <p>Lessons are delivered Monday to Friday only. No lessons are sent on weekends, Nigerian public holidays, or during scheduled maintenance periods. We aim to deliver lessons reliably but do not guarantee uninterrupted service. In the event of technical disruption we will notify subscribers and extend affected subscriptions accordingly.</p>

  <h2>8. AI Feedback</h2>
  <p>Task feedback is generated by an AI system powered by Anthropic's Claude. While we have designed the feedback system to be helpful and accurate, AI feedback is provided for educational purposes only and should not be treated as professional advice. We do not guarantee specific outcomes from following AI feedback.</p>

  <h2>9. Intellectual Property</h2>
  <p>All lesson content, including text, frameworks, examples, and materials delivered via SkillStack NG, is the intellectual property of Amaris Synergy Limited. Subscribers are granted a personal, non-transferable licence to access and use lesson content for their own learning. You may not:</p>
  <ul>
    <li>Reproduce, distribute, or resell lesson content</li>
    <li>Share lesson content with non-subscribers</li>
    <li>Use lesson content to create competing educational products</li>
    <li>Screenshot and publicly share complete lessons without permission</li>
  </ul>

  <h2>10. Acceptable Use</h2>
  <p>You agree to use SkillStack NG only for lawful purposes. You may not:</p>
  <ul>
    <li>Share your account access with others</li>
    <li>Attempt to reverse engineer or copy our bot system</li>
    <li>Send abusive, threatening, or inappropriate messages to our bot</li>
    <li>Use the service in any way that violates WhatsApp's terms of service</li>
  </ul>

  <h2>11. Disclaimer of Warranties</h2>
  <p>SkillStack NG is provided on an "as is" and "as available" basis. We make no warranties, express or implied, regarding the service including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the service will be error-free, uninterrupted, or that specific income or career outcomes will result from completing the programme.</p>

  <h2>12. Limitation of Liability</h2>
  <p>To the fullest extent permitted by Nigerian law, Amaris Synergy Limited shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of SkillStack NG. Our total liability to you for any claim arising from these Terms shall not exceed the amount you paid for your subscription in the 30 days prior to the claim.</p>

  <h2>13. Changes to These Terms</h2>
  <p>We may update these Terms from time to time. We will notify active subscribers of material changes via WhatsApp at least 14 days before they take effect. Your continued use of the service after changes take effect constitutes acceptance of the updated Terms.</p>

  <h2>14. Governing Law</h2>
  <p>These Terms are governed by the laws of the Federal Republic of Nigeria. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts of Lagos State, Nigeria.</p>

  <h2>15. Contact</h2>
  <p>For any questions about these Terms, contact us at:</p>
  <p><strong>Amaris Synergy Limited</strong><br/>
  12 Babatunde Street, Lagos, Nigeria<br/>
  Email: hello@skillstackng.com</p>
</body>
</html>`);
});


app.get('/choose', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'choose.html'));
});

app.post('/waitlist', async (req, res) => {
  try {
    const { name, phone, track } = req.body;
    let cleanPhone = (phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '234' + cleanPhone.substring(1);
    await supabase.from('waitlist').insert({
      name, phone: cleanPhone, track,
      created_at: new Date().toISOString()
    });
    await sendMessage('2347063667303',
      'New waitlist signup!\nName: ' + name + '\nPhone: ' + cleanPhone + '\nTrack: ' + track
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Waitlist error:', err.message);
    res.status(200).json({ success: true });
  }
});

app.get('/social-media-management', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'social-media-management.html'));
});

app.get('/copywriting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'copywriting.html'));
});

app.get('/affiliate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'affiliate.html'));
});

app.post('/affiliate-signup', async (req, res) => {
  try {
    const { name, phone, email, channel, bank, account, accountName } = req.body;

    // Clean phone number
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '234' + cleanPhone.substring(1);

    // Generate unique affiliate code
    const code = name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') +
      Math.floor(1000 + Math.random() * 9000);

    // Save to Supabase
    await supabase.from('affiliates').insert({
      name,
      phone: cleanPhone,
      email,
      channel,
      bank_name: bank,
      account_number: account,
      account_name: accountName,
      affiliate_code: code,
      status: 'pending',
      total_earnings: 0,
      pending_payout: 0,
      referral_count: 0,
      created_at: new Date().toISOString()
    });

    // Notify Amaris via WhatsApp
    await sendMessage('2347063667303',
      'New affiliate application!\n\n' +
      'Name: ' + name + '\n' +
      'Phone: ' + cleanPhone + '\n' +
      'Email: ' + email + '\n' +
      'Channel: ' + channel + '\n' +
      'Bank: ' + bank + ' — ' + account + ' (' + accountName + ')\n' +
      'Code: ' + code + '\n\n' +
      'Approve by updating their status in Supabase to "approved" and sending them their link:\n' +
      'https://paystack.shop/pay/2-h3igsfd2?ref=' + code
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Affiliate signup error:', err.message);
    res.status(500).json({ success: false });
  }
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
