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
const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER || '2347063667303';
const REFERRER_COMMUNITY_LINK = 'https://chat.whatsapp.com/BZWNc00a5EKBHBYoAyu0Kz';
const REFERRER_KIT_LINK = 'https://skillstackng.com/ambassador-kit';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_TEST_SECRET = process.env.PAYSTACK_TEST_SECRET_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'skillstack_verify_2024';

// Twilio rejects any message body over 1600 characters (error 21617) — split long
// messages (e.g. lesson content) into multiple sequential WhatsApp messages instead.
function splitMessage(body, maxLength = 1500) {
  if (body.length <= maxLength) return [body];
  const chunks = [];
  let remaining = body;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength * 0.5) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < 1) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Returns true only if the message was actually delivered. Twilio's
// messages.create() resolves as soon as Twilio *accepts* the request — for a
// WhatsApp send outside the recipient's 24h session window, Twilio still
// accepts it and only rejects it a moment later (status 'undelivered', error
// 63016) once it hears back from WhatsApp. Trusting create() not throwing
// was the bug: callers gating on delivery (link_sent flags, email fallback)
// were marking sends as successful that had actually failed. Since 63016 is
// a policy rejection (not a network delay), it resolves in a couple of
// seconds, so a short poll after create() is enough to catch it.
async function sendMessage(to, body) {
  try {
    const cleanNumber = to.replace(/\D/g, '');
    const formattedTo = 'whatsapp:+' + cleanNumber;
    const chunks = splitMessage(body);
    let allDelivered = true;
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? '(' + (i + 1) + '/' + chunks.length + ')\n\n' : '';
      const msg = await twilioClient.messages.create({
        from: TWILIO_NUMBER,
        to: formattedTo,
        body: prefix + chunks[i],
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const updated = await twilioClient.messages(msg.sid).fetch();
      if (updated.status === 'undelivered' || updated.status === 'failed') {
        console.error('Message undelivered to ' + cleanNumber + ' (error ' + updated.errorCode + ')');
        allDelivered = false;
      }
    }
    console.log('Sent to ' + cleanNumber + (allDelivered ? '' : ' (undelivered)'));
    return allDelivered;
  } catch (err) {
    console.error('Send error:', err.message);
    return false;
  }
}

async function sendEmail(to, subject, htmlContent) {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: 'SkillStack NG', email: 'hello@skillstackng.com' },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
      })
    });
    if (!response.ok) {
      console.error('Email send error:', response.status, await response.text());
      return false;
    }
    console.log('Email sent to ' + to);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
}

function referrerActivationEmailHtml(name, label, keyword, waLink) {
  return '<p>Hi ' + name + ',</p>' +
    '<p>Your SkillStack NG ' + label + ' application has been approved! 🎉</p>' +
    '<p>WhatsApp only lets us message a number that has messaged us first, so to get your unique referral link, send the word <strong>' + keyword + '</strong> to our WhatsApp number.</p>' +
    '<p><a href="' + waLink + '" style="display:inline-block;background:#25D366;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Text ' + keyword + ' on WhatsApp →</a></p>' +
    '<p>You will get your unique referral link back immediately.</p>' +
    '<p>— SkillStack NG</p>';
}

function referralStatsEmailHtml(name, label, code, referrer) {
  return '<p>Hi ' + name + ',</p>' +
    '<p>Here is your weekly SkillStack NG ' + label + ' summary:</p>' +
    '<ul>' +
    '<li>Referrals: ' + (referrer.referral_count || 0) + '</li>' +
    '<li>Total earned: ₦' + (referrer.total_earnings || 0).toLocaleString() + '</li>' +
    '<li>Pending payout: ₦' + (referrer.pending_payout || 0).toLocaleString() + '</li>' +
    '</ul>' +
    '<p>Your referral link: <a href="https://skillstackng.com/choose?ref=' + code + '">https://skillstackng.com/choose?ref=' + code + '</a></p>' +
    '<p>Payouts are processed weekly once your pending balance hits ₦5,000. Keep sharing!</p>' +
    '<p>— SkillStack NG</p>';
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

const TRACKS = {
  social_media_management: {
    label: 'Social Media Management',
    totalDays: 60,
    monthlyLink: 'https://paystack.shop/pay/p1kkgoo91-',
    fullLink: 'https://paystack.shop/pay/6aanjfut9m',
    fullPrice: '9,000 for 60 days (save 1,000)',
    fullExpiryDays: 65
  },
  content_writing: {
    label: 'Content Writing',
    totalDays: 90,
    monthlyLink: 'https://paystack.shop/pay/yn75oepjbw',
    fullLink: 'https://paystack.shop/pay/vd5zt2ws9q',
    fullPrice: '13,000 for 90 days (save 2,000)',
    fullExpiryDays: 95
  },
  digital_marketing: {
    label: 'Digital Marketing Fundamentals',
    totalDays: 90,
    monthlyLink: 'https://paystack.shop/pay/3ke4qasoo5',
    fullLink: 'https://paystack.shop/pay/wbmr9cgdyn',
    fullPrice: '13,000 for 90 days (save 2,000)',
    fullExpiryDays: 95
  },
  copywriting: {
    label: 'Copywriting & Persuasion',
    totalDays: 90,
    monthlyLink: 'https://paystack.shop/pay/2-h3igsfd2',
    fullLink: 'https://paystack.shop/pay/bo96lsmt2c',
    fullPrice: '13,000 for 90 days (save 2,000)',
    fullExpiryDays: 95
  },
  sales_lead_generation: {
    label: 'Sales & Lead Generation',
    totalDays: 90,
    monthlyLink: 'https://paystack.shop/pay/x3irlfttwr',
    fullLink: 'https://paystack.shop/pay/n28xp6t6so',
    fullPrice: '13,000 for 90 days (save 2,000)',
    fullExpiryDays: 95
  },
  freelancing: {
    label: 'Freelancing & Getting Online Clients',
    totalDays: 90,
    monthlyLink: 'https://paystack.shop/pay/r63q8robgg',
    fullLink: 'https://paystack.shop/pay/m6p-e7pt98',
    fullPrice: '13,000 for 90 days (save 2,000)',
    fullExpiryDays: 95
  }
};

function getTrackInfo(track) {
  return TRACKS[track] || TRACKS.copywriting;
}

// Brand-new subscribers who pay directly from a track's landing page (the
// normal ad-traffic path) never go through WhatsApp onboarding first, so
// there was no way to know which track they actually paid for — the webhook
// only ever saw a WhatsApp number and an amount, and 5 of the 6 tracks share
// the same price. Confirmed via a real transaction (Christopher Okafor,
// 2026-08-29) that Paystack's metadata.referrer reliably contains the exact
// payment page slug the customer paid through, e.g.
// "https://paystack.shop/pay/vd5zt2ws9q,https://skillstackng.com/" — which
// maps straight back to a track via TRACKS' own monthly/full links.
const PAYSTACK_SLUG_TO_TRACK = {};
Object.keys(TRACKS).forEach(key => {
  const t = TRACKS[key];
  PAYSTACK_SLUG_TO_TRACK[t.monthlyLink.split('/').pop()] = key;
  PAYSTACK_SLUG_TO_TRACK[t.fullLink.split('/').pop()] = key;
});
function extractTrackFromReferrer(referrer) {
  if (!referrer) return null;
  for (const slug in PAYSTACK_SLUG_TO_TRACK) {
    if (referrer.includes(slug)) return PAYSTACK_SLUG_TO_TRACK[slug];
  }
  return null;
}

function formatLesson(lesson, dayNumber, track) {
  const totalDays = getTrackInfo(track).totalDays;
  return 'Day ' + dayNumber + ' of ' + totalDays + ' - SkillStack NG\n\n' + lesson.title + '\n\n' + lesson.content + '\n\n---\nTODAYS TASK\n' + lesson.task + '\n\nReply with your answer and I will give you personal feedback.\n\n💡 Reply daily to keep your lessons coming — WhatsApp pauses messages to numbers that go quiet.';
}

async function activateSubscriber(whatsappNumber, name, planType = 'monthly', paymentInfo = {}) {
  try {
    const { refCode, amount, chargeReference, detectedTrack } = paymentInfo;
    const cleanPhone = whatsappNumber.replace(/\D/g, '');
    let finalPhone = cleanPhone;
    if (finalPhone.startsWith('0')) {
      finalPhone = '234' + finalPhone.substring(1);
    }

    console.log('Activating subscriber: ' + finalPhone);
    let sub = await getSubscriber(finalPhone);

    // Existing subscribers keep whatever track they already chose during
    // onboarding; brand-new ones only have detectedTrack (from the Paystack
    // referrer) to go on, falling back to copywriting if that's absent too.
    const effectiveTrack = sub ? sub.track : (detectedTrack || 'copywriting');

    // Set subscription expiry — full plans get the track's programme length, monthly always renews in 32 days
    const trackInfo = getTrackInfo(effectiveTrack);
    const expiryDays = planType === 'full' ? trackInfo.fullExpiryDays : 32;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + expiryDays);
    const subscriptionExpires = expiryDate.toISOString().split('T')[0];

    if (sub) {
      if (sub.active === 'true') {
        // Genuine renewal charge vs a duplicate webhook delivery for the same charge
        if (chargeReference && sub.last_charge_reference !== chargeReference) {
          await supabase.from('subscribers').update({ last_charge_reference: chargeReference }).eq('phone', finalPhone);
          if (sub.referred_by) await creditReferral(sub.referred_by, amount, false);
        }
        console.log('Subscriber already active — skipping duplicate: ' + finalPhone);
        return;
      }
      const finalRefCode = sub.referred_by || refCode || null;
      await supabase.from('subscribers').update({
        active: 'true',
        day_number: 1,
        streak: 1,
        plan_type: planType,
        subscription_expires: subscriptionExpires,
        last_active: new Date().toISOString().split('T')[0],
        track: sub.track || 'copywriting',
        referred_by: finalRefCode,
        last_charge_reference: chargeReference || null
      }).eq('phone', finalPhone);
      if (finalRefCode) await creditReferral(finalRefCode, amount, true);
    } else {
      await supabase.from('subscribers').insert({
        phone: finalPhone,
        name: name || 'Subscriber',
        day_number: 1,
        track: effectiveTrack,
        time_preference: null,
        active: 'true',
        streak: 1,
        plan_type: planType,
        subscription_expires: subscriptionExpires,
        last_active: new Date().toISOString().split('T')[0],
        referred_by: refCode || null,
        last_charge_reference: chargeReference || null
      });
      if (refCode) await creditReferral(refCode, amount, true);
    }

    const trackLabel = trackInfo.label;
    const planMsg = planType === 'full'
      ? 'Payment confirmed! Welcome to SkillStack NG ' + (name || '') + '. Your ' + trackLabel + ' journey is fully unlocked — no monthly renewals needed. 🎉'
      : 'Payment confirmed! Welcome to SkillStack NG ' + (name || '') + '. Your ' + trackLabel + ' journey starts NOW. 🎉';
    await sendMessage(finalPhone, planMsg);
    await sendMessage(finalPhone, 'One quick question — what is your first name?');
    console.log('Subscriber activated successfully: ' + finalPhone);
  } catch (err) {
    console.error('Activation error:', err.message);
  }
}

// Handles the AFFILIATE/AMBASSADOR WhatsApp trigger word: looks up the applicant
// by phone and either sends their approved link now (this reply is guaranteed to
// land since it's a direct response to their inbound message), tells them their
// application is still pending, or points them to the application form.
async function handleReferrerActivation(cleanPhone, table, codeField, label, applyUrl, keyword) {
  // A phone number can have more than one row here (e.g. someone reapplies to
  // update bank details) — .single() errors out when that happens, so pull
  // every match and prefer an approved one over a pending duplicate.
  const { data: matches } = await supabase.from(table).select('*').eq('phone', cleanPhone)
    .order('created_at', { ascending: false });
  const record = (matches || []).find(r => r.status === 'approved') || (matches || [])[0];

  if (!record) {
    await sendMessage(cleanPhone,
      'We do not have a ' + label + ' application on file for this number.\n\nApply here: ' + applyUrl
    );
    return;
  }

  if (record.status !== 'approved') {
    await sendMessage(cleanPhone,
      'Thanks ' + record.name + '! Your ' + label + ' application is still under review. We will message your referral link right here as soon as you are approved.'
    );
    return;
  }

  const link = 'https://skillstackng.com/choose?ref=' + record[codeField];
  await sendMessage(cleanPhone,
    'Congratulations ' + record.name + '! Your SkillStack NG ' + label + ' application has been approved.\n\n' +
    'Your unique referral link:\n' + link + '\n\n' +
    'Share this link with anyone interested in learning Copywriting, Social Media Management, Content Writing, Digital Marketing, Sales & Lead Generation, or Freelancing on WhatsApp.\n\n' +
    'You earn a commission on every successful payment made through your link. We will notify you when a referral converts and process payouts weekly.\n\n' +
    'We will email your referral and earnings stats to you every Monday.\n\n' +
    'Join our ' + label + ' community on WhatsApp for tips, updates, and support:\n' + REFERRER_COMMUNITY_LINK + '\n\n' +
    'Video creatives, banners, and ready-to-share messages:\n' + REFERRER_KIT_LINK + '\n\n' +
    'Questions? Reply here anytime. Text ' + keyword + ' any time to get your link again.'
  );
  await supabase.from(table).update({ link_sent: true }).eq('phone', cleanPhone);
}

async function handleOnboarding(phone, message) {
  const cleanPhone = phone.replace(/\D/g, '');

  if (message.trim().toUpperCase() === 'EARNINGS') {
    await sendMessage(cleanPhone,
      'Your referral stats (referrals, earnings, pending payout) are emailed to you every Monday — check your inbox! Not received one yet or need help? Email support@skillstackng.com.'
    );
    return;
  }

  // WhatsApp only lets a business message a number that has messaged it first
  // (or an approved template, which we don't have set up). Affiliates/ambassadors
  // sign up on a web form and never text us, so without this trigger their
  // approval link can never actually be delivered — see AFFILIATE/AMBASSADOR handling.
  if (message.trim().toUpperCase() === 'AFFILIATE') {
    await handleReferrerActivation(cleanPhone, 'affiliates', 'affiliate_code', 'Affiliate', 'https://skillstackng.com/affiliate', 'AFFILIATE');
    return;
  }
  if (message.trim().toUpperCase() === 'AMBASSADOR') {
    await handleReferrerActivation(cleanPhone, 'ambassadors', 'ambassador_code', 'Campus Ambassador', 'https://skillstackng.com/ambassador', 'AMBASSADOR');
    return;
  }

  // Lets anyone get real pricing without leaving WhatsApp or waiting on a
  // reply — used as the CTA on track pages and the exit-intent popup instead
  // of a lead-capture form, since texting this in *is* the capture (we get
  // their number and an open session, same guaranteed-delivery pattern as
  // AFFILIATE/AMBASSADOR) and skips the "no session yet" delivery problem
  // entirely.
  if (message.trim().toUpperCase() === 'PRICING') {
    const order = ['copywriting', 'social_media_management', 'content_writing', 'digital_marketing', 'sales_lead_generation', 'freelancing'];
    const numerals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
    const lines = order.map((key, i) => {
      const t = TRACKS[key];
      return numerals[i] + ' ' + t.label + ' — ' + t.totalDays + ' days\n₦5,000/month or ₦' + t.fullPrice;
    });
    await sendMessage(cleanPhone,
      'SkillStack NG pricing 💰\n\n' + lines.join('\n\n') +
      '\n\nEvery track: WhatsApp delivery, AI feedback on every task, cancel the monthly plan anytime.\n\n' +
      'See full details or pay: https://skillstackng.com/choose\n\n' +
      'Ready to start right here? Reply 1, 2, 3, 4, 5 or 6.'
    );
    // Log-only — lets us see how many people the exit-popup/track-page CTA
    // actually reach, since these leads otherwise only exist as WhatsApp
    // threads with no queryable record. Never blocks the reply above.
    const { error: pricingLogError } = await supabase.from('pricing_inquiries').insert({ phone: cleanPhone });
    if (pricingLogError) console.error('Pricing inquiry log error:', pricingLogError.message);
    return;
  }

  const sub = await getSubscriber(cleanPhone);

  if (!sub) {
    // Guard against affiliates/ambassadors landing here by accident — e.g. the
    // AFFILIATE/AMBASSADOR keyword didn't come through exactly (a mistyped word,
    // or a pre-filled wa.me link that didn't carry over). Without this check they
    // silently get registered as a brand-new student instead of reaching their
    // actual referral link — this is what happened to Adeojo Aderonke (2026-08-23).
    const { data: existingAffiliate } = await supabase.from('affiliates').select('id').eq('phone', cleanPhone).limit(1);
    if (existingAffiliate && existingAffiliate.length) {
      await sendMessage(cleanPhone, 'Looks like you have an affiliate application with us — text AFFILIATE to get your referral link.\n\nWant to also enrol as a student? Reply HI to start.');
      return;
    }
    const { data: existingAmbassador } = await supabase.from('ambassadors').select('id').eq('phone', cleanPhone).limit(1);
    if (existingAmbassador && existingAmbassador.length) {
      await sendMessage(cleanPhone, 'Looks like you have a Campus Ambassador application with us — text AMBASSADOR to get your referral link.\n\nWant to also enrol as a student? Reply HI to start.');
      return;
    }

    await supabase.from('subscribers').insert({
      phone: cleanPhone,
      name: '',
      day_number: 0,
      track: 'copywriting',
      time_preference: '07:00',
      active: 'false',
      streak: 0,
    });
    await sendMessage(cleanPhone, 'Welcome to SkillStack NG! 🎓\n\nWe deliver high-income skill lessons to your WhatsApp every weekday — 15 minutes a day, AI feedback on every task.\n\nChoose your track:\n\n1️⃣ Copywriting & Persuasion — 90 days\nWrite sales copy, ads, email sequences, and landing pages. Earn ₦100k–₦500k per project.\n\n2️⃣ Social Media Management — 60 days\nManage brand accounts professionally. Earn ₦80k–₦900k per month.\n\n3️⃣ Content Writing — 90 days\nWrite articles, blogs, and web content professionally. Earn ₦80k–₦400k per month.\n\n4️⃣ Digital Marketing Fundamentals — 90 days\nRun campaigns, manage ads, and grow brands online. Earn ₦100k–₦600k per month.\n\n5️⃣ Sales & Lead Generation — 90 days\nClose deals and generate consistent leads for Nigerian businesses. Earn ₦100k–₦600k per month.\n\n6️⃣ Freelancing & Getting Online Clients — 90 days\nFind clients, set your rates, and build a sustainable freelance income. Earn ₦100k–₦600k per month.\n\nReply 1, 2, 3, 4, 5 or 6 to get started.\n\nMade a mistake? Reply CHANGETRACK at any time before payment to restart.\n\n💡 Tip: Reply to your lesson each day, even just a few words — WhatsApp automatically pauses messages to numbers that go quiet, so staying active keeps your lessons coming.');
    return;
  }
// Allow inactive subscribers to correct their track before payment
  if (message.toUpperCase() === 'HELP' || message.toUpperCase() === 'SUPPORT') {
    await sendMessage(cleanPhone, 'SkillStack NG Support 🛠️\n\nFor any issue, email us at:\nsupport@skillstackng.com\n\nWe respond within 24 hours on weekdays.\n\nUseful commands:\nLESSON — resend today\'s lesson\nSTATUS — check your progress\nSTOP — cancel your subscription\nHELP — show this message\n\nFor general enquiries: hello@skillstackng.com');
    return;
  }
if (sub.active === 'false' && message.toUpperCase() === 'CHANGETRACK') {
  await supabase.from('subscribers').update({ track: 'copywriting', name: '' }).eq('phone', cleanPhone);
 await sendMessage(cleanPhone, 'No problem! Let\'s start over.\n\nChoose your track:\n\n1️⃣ Copywriting & Persuasion — 90 days\n2️⃣ Social Media Management — 60 days\n3️⃣ Content Writing — 90 days\n4️⃣ Digital Marketing Fundamentals — 90 days\n5️⃣ Sales & Lead Generation — 90 days\n6️⃣ Freelancing & Getting Online Clients — 90 days\n\nReply 1, 2, 3, 4, 5 or 6.');
  return;
}
  // Handle track selection
  const TRACK_MENU = {
    '1': { track: 'copywriting', name: 'Copywriting & Persuasion (90 days)' },
    '2': { track: 'social_media_management', name: 'Social Media Management (60 days)' },
    '3': { track: 'content_writing', name: 'Content Writing (90 days)' },
    '4': { track: 'digital_marketing', name: 'Digital Marketing Fundamentals (90 days)' },
    '5': { track: 'sales_lead_generation', name: 'Sales & Lead Generation (90 days)' },
    '6': { track: 'freelancing', name: 'Freelancing & Getting Online Clients (90 days)' }
  };
  if (sub.active === 'false' && sub.name === '' && TRACK_MENU[message]) {
    const { track: selectedTrack, name: trackName } = TRACK_MENU[message];
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

    if (sub.is_beta) {
      // Already paid the beta fee — activate immediately instead of asking to pay again
      await supabase.from('subscribers').update({
        time_preference: timePreference,
        active: 'true',
        day_number: 1,
        streak: 1,
        last_active: new Date(Date.now() - 86400000).toISOString().split('T')[0]
      }).eq('phone', cleanPhone);
      const lesson = await getLesson(1, sub.track || 'copywriting');
      await sendMessage(cleanPhone, 'Perfect ' + sub.name + '! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '. Here is your Day 1 lesson right now:');
      if (lesson) await sendMessage(cleanPhone, formatLesson(lesson, 1, sub.track));
      return;
    }

    await supabase.from('subscribers').update({ time_preference: timePreference }).eq('phone', cleanPhone);

    // Send correct payment links based on selected track
    const { monthlyLink, fullLink, fullPrice } = getTrackInfo(sub.track);

    await sendMessage(cleanPhone, 'Perfect ' + sub.name + '! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '.\n\nTo activate your subscription pay here:\n\nMonthly — ₦5,000/month:\n' + monthlyLink + '\n\nFull plan — ₦' + fullPrice + ':\n' + fullLink + '\n\nMake sure to enter this WhatsApp number in the payment form.');
    return;
  }

 // Collect name from newly activated subscribers
  if (sub.active === 'true' && sub.day_number === 1 && sub.name === 'Subscriber') {
    await supabase.from('subscribers').update({ name: message }).eq('phone', cleanPhone);
    await sendMessage(cleanPhone, 'Nice to meet you, ' + message + '! 👋\n\nWhat time do you want your daily lesson delivered?\n\nReply with:\n6AM\n7AM\n8AM\n12PM\n6PM\n9PM');
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
      last_active: new Date(Date.now() - 86400000).toISOString().split('T')[0],
      awaiting_task: true
    }).eq('phone', cleanPhone);
    const lesson = await getLesson(1, sub.track || 'copywriting');
    await sendMessage(cleanPhone, 'Perfect! Your lesson will arrive Monday to Friday at ' + message.toUpperCase() + '. Here is your Day 1 lesson right now:');
    if (lesson) {
      await sendMessage(cleanPhone, formatLesson(lesson, 1, sub.track));
    } else {
      console.error('No Day 1 lesson found for track: ' + sub.track);
      await sendMessage(cleanPhone, 'Your Day 1 lesson is being finalized — you will receive it within a few minutes. If you don\'t see it, reply LESSON.');
      await sendMessage(ADMIN_WHATSAPP_NUMBER, 'ALERT: No Day 1 lesson found for track "' + sub.track + '" (subscriber ' + cleanPhone + ')');
    }
    return;
  }

  if (sub.active === 'true' && sub.day_number > 0) {
    const lesson = await getLesson(sub.day_number, sub.track || 'copywriting');
    if (!lesson) {
      await sendMessage(cleanPhone, 'You have completed all available lessons. More coming soon!');
      return;
    }
    if (sub.name === 'Subscriber') {
      await sendMessage(cleanPhone, 'What is your first name?');
      return;
    }
    if (!sub.time_preference && (message.toUpperCase() === 'HI' || message.toUpperCase() === 'HELLO')) {
      await sendMessage(cleanPhone, 'What time do you want your daily lesson?\n\nReply with:\n6AM\n7AM\n8AM\n12PM\n6PM\n9PM');
      return;
    }
    if (message.toUpperCase() === 'LESSON' || message.toUpperCase() === 'HI' || message.toUpperCase() === 'HELLO' || message.toUpperCase() === 'YES' || message.toUpperCase() === 'CONTINUE') {
      await sendMessage(cleanPhone, formatLesson(lesson, sub.day_number, sub.track));
      await supabase.from('subscribers').update({ awaiting_task: true, lesson_delivered_at: new Date().toISOString() }).eq('phone', cleanPhone);
      return;
    }

    // Bot commands — checked before word count
    if (message.toUpperCase() === 'STATUS') {
      const trackInfo = getTrackInfo(sub.track);
      await sendMessage(cleanPhone, '📊 Your SkillStack NG Progress\n\nName: ' + sub.name + '\nTrack: ' + trackInfo.label + '\nDay: ' + sub.day_number + ' of ' + trackInfo.totalDays + '\nStreak: ' + sub.streak + ' days 🔥\nLesson time: ' + sub.time_preference + '\n\nKeep going — you are building a real skill. 💪');
      return;
    }
    if (message.toUpperCase() === 'PAUSE') {
      await supabase.from('subscribers').update({ active: 'paused' }).eq('phone', cleanPhone);
      await sendMessage(cleanPhone, '⏸️ Your lessons have been paused, ' + sub.name + '.\n\nYou are on Day ' + sub.day_number + '. Reply RESUME when you are ready to continue — you will pick up exactly where you left off. 🙏');
      return;
    }
    if (message.toUpperCase() === 'STOP' || message.toUpperCase() === 'CANCEL') {
      await supabase.from('subscribers').update({ active: 'false' }).eq('phone', cleanPhone);
      await sendMessage(cleanPhone, '🛑 Your SkillStack NG subscription has been cancelled, ' + sub.name + '.\n\nYou completed Day ' + sub.day_number + ' of your track. If you ever want to continue, email support@skillstackng.com and we will reactivate your account.\n\nThank you for learning with us. 🙏');
      return;
    }

    if (!sub.awaiting_task) {
      await sendMessage(cleanPhone, 'You have already submitted today\'s task! Your next lesson will arrive at your scheduled time. Keep going! 💪');
      return;
    }

    const wordCount = message.trim().split(/\s+/).length;
    if (wordCount < 5) {
      await sendMessage(cleanPhone, 'Your next lesson will arrive at your scheduled time. Keep going! 💪\n\nNeed your lesson now? Reply LESSON.');
      return;
    }
    const feedback = await getFeedback(lesson.task, message, lesson.feedback_prompt);
    await sendMessage(cleanPhone, 'Feedback on Day ' + sub.day_number + ':\n\n' + feedback + '\n\nStreak: ' + (sub.streak + 1) + ' days. Keep going!\n\nQuestions, stuck on something, or not sure what to do next? Just reply here — happy to help.');
    const nextDay = sub.day_number < 65 ? sub.day_number + 1 : sub.day_number;
    await supabase.from('subscribers').update({
      day_number: nextDay,
      streak: sub.streak + 1,
      last_active: new Date().toISOString().split('T')[0],
      awaiting_task: false
    }).eq('phone', cleanPhone);
    return;
  }

  // RESUME command
  if (sub.active === 'paused' && message.toUpperCase() === 'RESUME') {
    await supabase.from('subscribers').update({ active: 'true', awaiting_task: true }).eq('phone', cleanPhone);
    const lesson = await getLesson(sub.day_number, sub.track || 'copywriting');
    await sendMessage(cleanPhone, '▶️ Welcome back, ' + sub.name + '! Your lessons are now active again.\n\nYou are picking up from Day ' + sub.day_number + '. Here is your lesson:');
    if (lesson) await sendMessage(cleanPhone, formatLesson(lesson, sub.day_number, sub.track));
    return;
  }
  if (sub.active === 'false') {
    if (sub.is_beta) {
      // Recovery path — already paid the beta fee but got stuck before activation
      await supabase.from('subscribers').update({ active: 'true', day_number: 1, streak: 1 }).eq('phone', cleanPhone);
      const lesson = await getLesson(1, sub.track || 'copywriting');
      await sendMessage(cleanPhone, 'Sorry for the delay, ' + sub.name + '! Your beta payment is already confirmed — here is your Day 1 lesson:');
      if (lesson) await sendMessage(cleanPhone, formatLesson(lesson, 1, sub.track));
      return;
    }
    const { monthlyLink, fullLink, fullPrice } = getTrackInfo(sub.track);
    await sendMessage(cleanPhone, 'To activate your subscription pay here:\n\nMonthly — ₦5,000/month:\n' + monthlyLink + '\n\nFull plan — ₦' + fullPrice + ':\n' + fullLink);
    return;
  }

  if (sub.active === 'paused') {
    await sendMessage(cleanPhone, 'Your lessons are paused, ' + sub.name + '. Reply RESUME to pick up from Day ' + sub.day_number + ', or STOP to cancel your subscription.');
    return;
  }

  await sendMessage(cleanPhone, 'Welcome back! Reply 1 for Copywriting, 2 for Social Media Management, 3 for Content Writing, 4 for Digital Marketing, 5 for Sales & Lead Generation or 6 for Freelancing to get started.');
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function generateReferralCode(name) {
  return name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') +
    Math.floor(1000 + Math.random() * 9000);
}

// Paystack payment pages may or may not forward URL query params (?ref=CODE) into
// transaction metadata — check every plausible location; returns null if absent,
// which just means this particular signup won't be attributed to a referrer.
function parseRefCode(value) {
  if (typeof value !== 'string' || !value) return null;
  // Paystack's metadata.referrer often carries a full URL/referrer chain rather than
  // a clean value, e.g. "https://paystack.shop/pay/xxx?ref=CODE,https://skillstackng.com/"
  // - pull the ref=CODE out of it if present.
  const match = value.match(/[?&]ref=([a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9]+$/.test(value.trim())) return value.trim();
  return null;
}

function extractRefCode(data) {
  if (!data.metadata) return null;
  const candidates = [data.metadata.ref, data.metadata.referrer];
  if (data.metadata.custom_fields) {
    data.metadata.custom_fields.forEach(f => {
      if (f.variable_name === 'ref' || f.display_name === 'ref' ||
          f.variable_name === 'referrer' || f.display_name === 'Referrer') {
        candidates.push(f.value);
      }
    });
  }
  for (const candidate of candidates) {
    const code = parseRefCode(candidate);
    if (code) return code;
  }
  return null;
}

// Commission: 30% on a subscriber's first monthly payment, 19% on a first full-plan
// payment, 10% on every subsequent monthly renewal. Rates from affiliate.html's
// published commission table. Does not touch referral_count - that's tracked
// separately by /track-referral (client-side, fires on the thankyou page).
async function creditReferral(refCode, amount, isFirstPayment) {
  if (!refCode || !amount) return;
  const rate = isFirstPayment ? (amount >= 9000 ? 0.19 : 0.30) : 0.10;
  const commission = Math.round(amount * rate);

  const { data: affiliate } = await supabase
    .from('affiliates').select('*').eq('affiliate_code', refCode).eq('status', 'approved').single();
  if (affiliate) {
    await supabase.from('affiliates').update({
      total_earnings: (affiliate.total_earnings || 0) + commission,
      pending_payout: (affiliate.pending_payout || 0) + commission
    }).eq('affiliate_code', refCode);
    console.log('Credited ₦' + commission + ' to affiliate ' + refCode);
    return;
  }

  const { data: ambassador } = await supabase
    .from('ambassadors').select('*').eq('ambassador_code', refCode).eq('status', 'approved').single();
  if (ambassador) {
    await supabase.from('ambassadors').update({
      total_earnings: (ambassador.total_earnings || 0) + commission,
      pending_payout: (ambassador.pending_payout || 0) + commission
    }).eq('ambassador_code', refCode);
    console.log('Credited ₦' + commission + ' to ambassador ' + refCode);
  }
}

app.post('/paystack-webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'] || '';
    const hashLive = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body).digest('hex');
    const hashTest = PAYSTACK_TEST_SECRET
      ? crypto.createHmac('sha512', PAYSTACK_TEST_SECRET)
          .update(req.body).digest('hex')
      : null;

    if (!safeEqual(hashLive, signature) && !(hashTest && safeEqual(hashTest, signature))) {
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
        if (amount >= 9000) planType = 'full';
        const refCode = extractRefCode(data);
        const chargeReference = data.reference;
        const detectedTrack = extractTrackFromReferrer(data.metadata && data.metadata.referrer);

        // Beta payment — run full onboarding inside bot
        if (amount <= 200) {
          const betaPhone = whatsappNumber.replace(/\D/g, '');
          const existingSub = await getSubscriber(betaPhone);
          if (existingSub) {
            // Duplicate/retried webhook delivery for the same payment — don't re-send
            // the welcome message and reset their onboarding progress.
            console.log('Beta payment webhook duplicate — subscriber already exists, skipping resend: ' + betaPhone);
            return;
          }
          await supabase.from('subscribers').insert({
            phone: betaPhone,
            name: '',
            day_number: 0,
            track: 'copywriting',
            time_preference: '07:00',
            active: 'false',
            streak: 0,
            plan_type: 'monthly',
            is_beta: true,
            subscription_expires: new Date(Date.now() + 32 * 86400000).toISOString().split('T')[0],
            last_active: new Date().toISOString().split('T')[0]
          });
          await sendMessage(betaPhone, 'Payment confirmed! Welcome to SkillStack NG Beta. 🎉\n\nChoose your track:\n\n1️⃣ Copywriting & Persuasion — 90 days\n2️⃣ Social Media Management — 60 days\n3️⃣ Content Writing — 90 days\n4️⃣ Digital Marketing Fundamentals — 90 days\n5️⃣ Sales & Lead Generation — 90 days\n6️⃣ Freelancing & Getting Online Clients — 90 days\n\nReply 1, 2, 3, 4, 5 or 6 to get started.');
          return;
        }

        await activateSubscriber(whatsappNumber, customerName, planType, { refCode, amount, chargeReference, detectedTrack });
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
   await sendMessage(sub.phone, formatLesson(lesson, sub.day_number, sub.track));
    await supabase.from('subscribers').update({
      last_active: today,
      awaiting_task: true
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
  // last_active gets bumped to today the moment a lesson is *delivered* (see the
  // hourly cron above), not when it's actually answered — so for anyone with a
  // 12PM/6PM/9PM time_preference, last_active === yesterday is simply their normal
  // daily state and does NOT mean they missed anything. awaiting_task is the field
  // that actually means "hasn't answered yet"; last_active != today just excludes
  // people whose lesson was delivered earlier this same morning (give them the day).
  const today = new Date().toISOString().split('T')[0];
  const { data: missedSubscribers } = await supabase
    .from('subscribers')
    .select('*')
    .eq('active', 'true')
    .eq('awaiting_task', true)
    .neq('last_active', today);
  if (!missedSubscribers) return;
  for (const sub of missedSubscribers) {
    const now = new Date();
    const watDay = new Date(now.getTime() + 60 * 60 * 1000).getDay();
    if (watDay === 0 || watDay === 6) continue;
    await sendMessage(sub.phone, 'Hey ' + sub.name + '! You missed yesterday\'s lesson. Reply CONTINUE and I will send it now. Your streak is at ' + sub.streak + ' days — keep it going!\n\n⚠️ Heads up: if you stay quiet much longer, WhatsApp will automatically pause messages to your number. Reply today to keep your lessons coming.');
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

    const info = getTrackInfo(sub.track);

    // Send renewal message
    await sendMessage(sub.phone,
      'Hi ' + sub.name + ', your SkillStack NG subscription has expired and your lessons have been paused.\n\n' +
      'To continue your ' + info.label + ' journey from Day ' + sub.day_number + ', renew here:\n\n' +
      'Monthly - ₦5,000/month: ' + info.monthlyLink + '\n\n' +
      'Full plan - ₦' + info.fullPrice + ': ' + info.fullLink + '\n\n' +
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
    const info = getTrackInfo(sub.track);
    await sendMessage(sub.phone,
      'Hi ' + sub.name + '! Your SkillStack NG subscription renews in 3 days.\n\n' +
      'If your card details have changed or you would like to switch to the full plan (₦' + info.fullPrice + '), update here:\n\n' +
      info.fullLink + '\n\n' +
      'Otherwise your monthly renewal will happen automatically. Keep going!'
    );
  }
});

// Auto-send referral links to newly approved affiliates and ambassadors — runs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  const { data: approvedAffiliates } = await supabase
    .from('affiliates')
    .select('*')
    .eq('status', 'approved')
    .or('link_sent.is.null,link_sent.eq.false');

  for (const affiliate of approvedAffiliates || []) {
    const link = 'https://skillstackng.com/choose?ref=' + affiliate.affiliate_code;
    const sent = await sendMessage(affiliate.phone,
      'Congratulations ' + affiliate.name + '! Your SkillStack NG affiliate application has been approved.\n\n' +
      'Your unique referral link:\n' + link + '\n\n' +
      'Share this link with anyone interested in learning Copywriting, Social Media Management, Content Writing, Digital Marketing, Sales & Lead Generation, or Freelancing on WhatsApp.\n\n' +
      'You earn a commission on every successful payment made through your link. We will notify you when a referral converts and process payouts weekly.\n\n' +
      'We will email your referral and earnings stats to you every Monday.\n\n' +
      'Join our affiliate community on WhatsApp for tips, updates, and support:\n' + REFERRER_COMMUNITY_LINK + '\n\n' +
      'Video creatives, banners, and ready-to-share messages:\n' + REFERRER_KIT_LINK + '\n\n' +
      'Questions? Reply here anytime.'
    );
    // Only clear the flag on confirmed delivery — WhatsApp rejects this send unless
    // the affiliate has texted us within the last 24h, which most haven't yet.
    // Their AFFILIATE keyword reply (handleReferrerActivation) is the reliable path;
    // this cron only succeeds for the ones who happened to text in before approval.
    if (sent) {
      await supabase.from('affiliates').update({ link_sent: true }).eq('phone', affiliate.phone);
      console.log('Auto-sent affiliate link to: ' + affiliate.phone);
    }
  }

  const { data: approvedAmbassadors } = await supabase
    .from('ambassadors')
    .select('*')
    .eq('status', 'approved')
    .or('link_sent.is.null,link_sent.eq.false');

  for (const ambassador of approvedAmbassadors || []) {
    const link = 'https://skillstackng.com/choose?ref=' + ambassador.ambassador_code;
    const sent = await sendMessage(ambassador.phone,
      'Congratulations ' + ambassador.name + '! Your SkillStack NG Campus Ambassador application has been approved.\n\n' +
      'Your unique referral link:\n' + link + '\n\n' +
      'Share this link with students on your campus interested in learning Copywriting, Social Media Management, Content Writing, Digital Marketing, Sales & Lead Generation, or Freelancing on WhatsApp.\n\n' +
      'You earn 30% commission on every successful payment made through your link. We will notify you when a referral converts and process payouts weekly.\n\n' +
      'We will email your referral and earnings stats to you every Monday.\n\n' +
      'Join our ambassador community on WhatsApp for tips, updates, and support:\n' + REFERRER_COMMUNITY_LINK + '\n\n' +
      'Video creatives, banners, and ready-to-share messages:\n' + REFERRER_KIT_LINK + '\n\n' +
      'Questions? Reply here anytime.'
    );
    if (sent) {
      await supabase.from('ambassadors').update({ link_sent: true }).eq('phone', ambassador.phone);
      console.log('Auto-sent ambassador link to: ' + ambassador.phone);
    }
  }
});

// Weekly referral/earnings summary email for approved affiliates and ambassadors — every Monday 8AM WAT
cron.schedule('0 7 * * 1', async () => {
  console.log('Sending weekly referral stats emails...');

  const { data: affiliates } = await supabase.from('affiliates').select('*').eq('status', 'approved');
  for (const affiliate of affiliates || []) {
    if (!affiliate.email) continue;
    await sendEmail(
      affiliate.email,
      'Your SkillStack NG Affiliate Stats This Week',
      referralStatsEmailHtml(affiliate.name, 'Affiliate', affiliate.affiliate_code, affiliate)
    );
  }

  const { data: ambassadors } = await supabase.from('ambassadors').select('*').eq('status', 'approved');
  for (const ambassador of ambassadors || []) {
    if (!ambassador.email) continue;
    await sendEmail(
      ambassador.email,
      'Your SkillStack NG Ambassador Stats This Week',
      referralStatsEmailHtml(ambassador.name, 'Campus Ambassador', ambassador.ambassador_code, ambassador)
    );
  }

  console.log('Weekly referral stats emails sent.');
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
    const { name, email, phone, track } = req.body;
    if (!name || !email || !phone) return res.status(400).json({ success: false, error: 'Name, email and phone are required' });
    let cleanPhone = (phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '234' + cleanPhone.substring(1);
    const { error } = await supabase.from('waitlist').insert({
      name, email, phone: cleanPhone, track,
      created_at: new Date().toISOString()
    });
    if (error) console.error('Waitlist insert error:', error.message);
    await sendMessage(ADMIN_WHATSAPP_NUMBER,
      'New waitlist signup!\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + cleanPhone + '\nTrack: ' + track
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Waitlist error:', err.message);
    res.status(200).json({ success: true });
  }
});
app.get('/content-writing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'content-writing.html'));
});
app.get('/ambassador', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ambassador.html'));
});
app.get('/free-guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'free-guide.html'));
});

app.post('/download-guide', async (req, res) => {
  try {
    const { name, email, phone, track } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const cleanPhone = phone ? phone.replace(/\D/g, '').replace(/^0/, '234') : '';

    // Save to Supabase
    await supabase.from('leads').insert({
      name,
      email,
      phone: cleanPhone,
      track_interest: track || 'not specified',
      source: 'free-guide',
      created_at: new Date().toISOString()
    });

    // Add to Brevo and trigger email sequence
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        email: email,
        attributes: {
          FIRSTNAME: name,
          PHONE: cleanPhone,
          TRACK_INTEREST: track || 'not specified'
        },
        listIds: [3],
        updateEnabled: true
      })
    });

    // Notify you on WhatsApp
    await sendMessage(ADMIN_WHATSAPP_NUMBER,
      'New Guide Download!\n\nName: ' + name +
      '\nEmail: ' + email +
      '\nPhone: ' + (cleanPhone || 'not provided') +
      '\nTrack interest: ' + (track || 'not specified'));

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Guide download error:', err.message);
    res.status(200).json({ success: true });
  }
});
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});
app.get('/ambassador-kit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ambassador-kit.html'));
});
app.get('/demo-video', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo-video.html'));
});
app.get('/digital-marketing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'digital-marketing.html'));
});
app.get('/sales-lead-generation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sales-lead-generation.html'));
});
app.get('/freelancing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'freelancing.html'));
});

// No explicit /blog route — express.static already serves public/blog/index.html
// for both /blog (301s to add the trailing slash first) and /blog/.
const BLOG_SLUGS = [
  'pas-copywriting-formula',
  'content-calendar-nigerian-brands',
  'headlines-that-earn-the-click',
  'digital-marketing-funnel-nigeria',
  'open-a-sales-conversation',
  'price-freelance-services-nigeria'
];
BLOG_SLUGS.forEach(slug => {
  app.get('/blog/' + slug, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', slug + '.html'));
  });
});
app.get('/social-media-management', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'social-media-management.html'));
});

app.get('/copywriting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'copywriting.html'));
});
app.get('/ambassador', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ambassador.html'));
});

app.post('/ambassador-apply', async (req, res) => {
  try {
    const { name, phone, email, school, department, state, plan, track } = req.body;
    if (!name || !phone || !email) return res.status(400).json({ success: false, error: 'Name, phone and email are required' });
    let cleanPhone = (phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '234' + cleanPhone.substring(1);

    // Generate unique ambassador code
    const code = generateReferralCode(name);

    await supabase.from('ambassadors').insert({
      name,
      phone: cleanPhone,
      email,
      school,
      department,
      state,
      plan,
      track,
      ambassador_code: code,
      status: 'pending',
      total_earnings: 0,
      pending_payout: 0,
      referral_count: 0,
      link_sent: false,
      created_at: new Date().toISOString()
    });

    await sendMessage(ADMIN_WHATSAPP_NUMBER,
      'New Ambassador Application!\n\n' +
      'Name: ' + name + '\n' +
      'Phone: ' + cleanPhone + '\n' +
      'Email: ' + email + '\n' +
      'School: ' + school + '\n' +
      'Department: ' + department + '\n' +
      'State: ' + state + '\n' +
      'Track: ' + track + '\n' +
      'Code: ' + code + '\n\n' +
      'Plan: ' + plan + '\n\n' +
      'Approve by updating their status in Supabase to "approved" — their link will be sent automatically.'
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Ambassador apply error:', err.message);
    res.status(200).json({ success: true });
  }
});
app.get('/affiliate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'affiliate.html'));
});

app.post('/affiliate-signup', async (req, res) => {
  try {
    const { name, phone, email, channel, bank, account, accountName } = req.body;
    if (!name || !phone || !email || !bank || !account || !accountName) {
      return res.status(400).json({ success: false, error: 'Name, phone, email and bank details are required' });
    }

    // Clean phone number
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '234' + cleanPhone.substring(1);

    // Generate unique affiliate code
    const code = generateReferralCode(name);

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
      link_sent: false,
      created_at: new Date().toISOString()
    });

    // Notify Amaris via WhatsApp
    await sendMessage(ADMIN_WHATSAPP_NUMBER,
      'New affiliate application!\n\n' +
      'Name: ' + name + '\n' +
      'Phone: ' + cleanPhone + '\n' +
      'Email: ' + email + '\n' +
      'Channel: ' + channel + '\n' +
      'Bank: ' + bank + ' — ' + account + ' (' + accountName + ')\n' +
      'Code: ' + code + '\n\n' +
      'Approve by updating their status in Supabase to "approved" and sending them their link:\n' +
      'https://skillstackng.com/choose?ref=' + code
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Affiliate signup error:', err.message);
    res.status(500).json({ success: false });
  }
});
app.post('/track-referral', async (req, res) => {
  try {
    const { ref } = req.body;
    if (!ref) return res.status(400).json({ success: false });

    const { data: affiliate } = await supabase
      .from('affiliates')
      .select('*')
      .eq('affiliate_code', ref)
      .eq('status', 'approved')
      .single();

    if (affiliate) {
      await supabase
        .from('affiliates')
        .update({ referral_count: (affiliate.referral_count || 0) + 1 })
        .eq('affiliate_code', ref);
      console.log('Referral tracked for affiliate: ' + ref);
      return res.status(200).json({ success: true });
    }

    const { data: ambassador } = await supabase
      .from('ambassadors')
      .select('*')
      .eq('ambassador_code', ref)
      .eq('status', 'approved')
      .single();

    if (!ambassador) return res.status(200).json({ success: false, reason: 'not found' });

    await supabase
      .from('ambassadors')
      .update({ referral_count: (ambassador.referral_count || 0) + 1 })
      .eq('ambassador_code', ref);

    console.log('Referral tracked for ambassador: ' + ref);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Track referral error:', err.message);
    res.status(200).json({ success: false });
  }
});
app.get('/approve-affiliate', async (req, res) => {
  try {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).send('Phone number required');

    const { data: affiliateMatches } = await supabase
      .from('affiliates')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false });
    const affiliate = (affiliateMatches || []).find(r => r.status === 'approved') || (affiliateMatches || [])[0];

    if (!affiliate) return res.status(404).send('Affiliate not found');
    if (affiliate.status !== 'approved') return res.status(400).send('Affiliate not approved yet — update status in Supabase first');

    const link = 'https://skillstackng.com/choose?ref=' + affiliate.affiliate_code;

    const sent = await sendMessage(phone,
      'Congratulations ' + affiliate.name + '! Your SkillStack NG affiliate application has been approved.\n\n' +
      'Your unique referral link:\n' + link + '\n\n' +
      'Share this link with anyone interested in learning Copywriting, Social Media Management, Content Writing, Digital Marketing, Sales & Lead Generation, or Freelancing on WhatsApp.\n\n' +
      'You earn a commission on every successful payment made through your link. We will notify you when a referral converts and process payouts weekly.\n\n' +
      'We will email your referral and earnings stats to you every Monday.\n\n' +
      'Join our affiliate community on WhatsApp for tips, updates, and support:\n' + REFERRER_COMMUNITY_LINK + '\n\n' +
      'Video creatives, banners, and ready-to-share messages:\n' + REFERRER_KIT_LINK + '\n\n' +
      'Questions? Reply here anytime.'
    );

    if (!sent) {
      if (affiliate.email) {
        const emailed = await sendEmail(affiliate.email,
          'Your SkillStack NG Affiliate Application Has Been Approved!',
          referrerActivationEmailHtml(affiliate.name, 'Affiliate', 'AFFILIATE', 'https://wa.me/15554075935?text=AFFILIATE')
        );
        return res.status(200).send((emailed ? 'WhatsApp not delivered, emailed instead: ' : 'WhatsApp not delivered AND email failed: ') + affiliate.email);
      }
      return res.status(200).send('Message NOT delivered (no open WhatsApp session with ' + phone + ') and no email on file — they need to text AFFILIATE to our WhatsApp number to receive it.');
    }

    await supabase.from('affiliates').update({ link_sent: true }).eq('phone', phone);

    res.status(200).send('Affiliate notified successfully: ' + phone);
  } catch (err) {
    console.error('Approve affiliate error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/approve-ambassador', async (req, res) => {
  try {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).send('Phone number required');

    const { data: ambassadorMatches } = await supabase
      .from('ambassadors')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false });
    const ambassador = (ambassadorMatches || []).find(r => r.status === 'approved') || (ambassadorMatches || [])[0];

    if (!ambassador) return res.status(404).send('Ambassador not found');
    if (ambassador.status !== 'approved') return res.status(400).send('Ambassador not approved yet — update status in Supabase first');

    const link = 'https://skillstackng.com/choose?ref=' + ambassador.ambassador_code;

    const sent = await sendMessage(phone,
      'Congratulations ' + ambassador.name + '! Your SkillStack NG Campus Ambassador application has been approved.\n\n' +
      'Your unique referral link:\n' + link + '\n\n' +
      'Share this link with students on your campus interested in learning Copywriting, Social Media Management, Content Writing, Digital Marketing, Sales & Lead Generation, or Freelancing on WhatsApp.\n\n' +
      'You earn 30% commission on every successful payment made through your link. We will notify you when a referral converts and process payouts weekly.\n\n' +
      'We will email your referral and earnings stats to you every Monday.\n\n' +
      'Join our ambassador community on WhatsApp for tips, updates, and support:\n' + REFERRER_COMMUNITY_LINK + '\n\n' +
      'Video creatives, banners, and ready-to-share messages:\n' + REFERRER_KIT_LINK + '\n\n' +
      'Questions? Reply here anytime.'
    );

    if (!sent) {
      if (ambassador.email) {
        const emailed = await sendEmail(ambassador.email,
          'Your SkillStack NG Campus Ambassador Application Has Been Approved!',
          referrerActivationEmailHtml(ambassador.name, 'Campus Ambassador', 'AMBASSADOR', 'https://wa.me/15554075935?text=AMBASSADOR')
        );
        return res.status(200).send((emailed ? 'WhatsApp not delivered, emailed instead: ' : 'WhatsApp not delivered AND email failed: ') + ambassador.email);
      }
      return res.status(200).send('Message NOT delivered (no open WhatsApp session with ' + phone + ') and no email on file — they need to text AMBASSADOR to our WhatsApp number to receive it.');
    }

    await supabase.from('ambassadors').update({ link_sent: true }).eq('phone', phone);

    res.status(200).send('Ambassador notified successfully: ' + phone);
  } catch (err) {
    console.error('Approve ambassador error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// Permanent (unlike the one-off /admin endpoints elsewhere): a repeatable way
// to check any subscriber's setup and actual WhatsApp delivery status,
// instead of rebuilding a one-off diagnostic every time a "did they get it"
// question comes up. Checks Supabase's subscriber record against Twilio's
// real delivery log — link_sent/active flags only ever prove we *attempted*
// a send, not that WhatsApp delivered it.
app.get('/admin/subscriber-status', async (req, res) => {
  try {
    if (req.query.key !== VERIFY_TOKEN) return res.status(403).send('Forbidden');
    let phone = (req.query.phone || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '234' + phone.substring(1);
    if (!phone) return res.status(400).send('phone query param required');

    const sub = await getSubscriber(phone);
    const messages = await twilioClient.messages.list({ to: 'whatsapp:+' + phone, limit: 10 });
    const outboundLog = messages.filter(m => m.direction === 'outbound-api').map(m => ({
      dateSent: m.dateSent, status: m.status, errorCode: m.errorCode, bodyPreview: (m.body || '').slice(0, 80)
    }));
    const inboundMessages = await twilioClient.messages.list({ from: 'whatsapp:+' + phone, limit: 5 });
    const lastInbound = inboundMessages[0] ? { dateSent: inboundMessages[0].dateSent, bodyPreview: (inboundMessages[0].body || '').slice(0, 80) } : null;

    res.status(200).json({
      subscriber: sub,
      everReplied: !!lastInbound,
      lastInbound,
      outboundLog
    });
  } catch (err) {
    console.error('Subscriber status error:', err.message);
    res.status(500).send('Error: ' + err.message);
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
// CORS preflight for DOF health check
app.options('/dof-health-check', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// DOF Health Check endpoint
app.post('/dof-health-check', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');

  const { answers } = req.body;
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const summaryText = answers.map(a => `${a.question}: ${a.answer}`).join('\n');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `You are the AI assessment engine for Doctor of the Future (DOF), a Nigerian nutrition practice run by Gideon Bassey, a professional nutritionist in Lagos. Analyse the person's health survey answers and produce a personalized Nigerian nutrition assessment. Be warm, encouraging, and clinically grounded. Always use Nigerian foods and context.

Respond ONLY with valid JSON and nothing else — no markdown, no backticks, no preamble:
{
  "health_score": <integer 10-100, honest score based on their lifestyle and health risk>,
  "summary": <2 clear sentences about their current health situation>,
  "insight_1": <1-2 sentences: most important insight about their specific situation>,
  "insight_2": <1-2 sentences: second key insight tied to their diet or habits>,
  "insight_3": <1-2 sentences: encouraging — what is possible for them>,
  "eat_1": { "food": "<specific Nigerian food>", "reason": "<1 sentence why it helps their situation>" },
  "eat_2": { "food": "<specific Nigerian food>", "reason": "<1 sentence>" },
  "eat_3": { "food": "<specific Nigerian food>", "reason": "<1 sentence>" },
  "avoid_1": { "food": "<Nigerian food from their answers>", "reason": "<1 sentence specific harm>" },
  "avoid_2": { "food": "<Nigerian food>", "reason": "<1 sentence>" },
  "avoid_3": { "food": "<Nigerian food>", "reason": "<1 sentence>" },
  "program_name": <exactly one of: "KnightUp Challenge", "Weight Gain and Gut Fix Bootcamp", "Sexual Health and Fertility Bootcamp", "Premium Nutrition Plan", "Star Nutrition Plan">,
  "program_reason": <1-2 sentences why this DOF program fits their situation>,
  "first_action": <single most important thing to start or stop TODAY, specific and practical>
}`,
      messages: [{ role: 'user', content: `Health survey answers:\n\n${summaryText}\n\nGenerate the JSON assessment.` }]
    });

    const raw = message.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    return res.json({ success: true, result });

  } catch (err) {
    console.error('DOF assessment error:', err.message);
    return res.status(500).json({ success: false, error: 'Assessment generation failed' });
  }
});
app.listen(PORT, () => {
  console.log('SkillStack NG running on port ' + PORT);
});
