const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
const CONTENT_SID = process.env.TWILIO_CONTENT_SID;

async function sendMessage(to, body) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to: `whatsapp:${to}`,
      contentSid: CONTENT_SID,
      contentVariables: JSON.stringify({ "1": body }),
    });
    console.log(`Sent to ${to}`);
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
      content: `${feedbackPrompt}\n\nLesson task: ${task}\n\nStudent submission: ${submission}`
    }],
  });
  return message.content[0].text;
}

function formatLesson(lesson, dayNumber) {
  return `Day ${dayNumber} of 90 - SkillStack NG\n\n${lesson.title}\n\n${lesson.content}\n\n---\nTODAY'S TASK\n${lesson.task}\n\nReply with your answer and I will give you personal feedback.`;
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
    await sendMessage(phone, 'Welcome to SkillStack NG! You are about to learn copywriting in 90 days - 15 minutes a day. Reply 1 to get started.');
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
    await sendMessage(phone, `Nice to meet you ${name}! What time do you want your daily lesson? Reply: 6AM, 7AM, 8AM, 12PM, 6PM or 9PM`);
    return;
  }

  const validTimes = ['6AM', '7AM', '8AM', '12PM', '6PM', '9PM'];
  if (sub.active === 'false' && sub.name !== '' && sub.name !== 'AWAITING' && validTimes.includes(message.toUpperCase())) {
    const timeMap = { '6AM': '06:00', '7AM': '07:00', '8AM': '08:00', '12PM': '12:00', '6PM': '18:00', '9PM': '21:00' };
    await supabase.from('subscribers').update({ time_preference: timeMap[message.toUpperCase()] }).eq('phone', phone);
    await sendMessage(phone, `Set! Your lesson arrives every day at ${message.toUpperCase()}. To activate your subscription pay 3
