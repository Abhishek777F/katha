'use strict';

const admin = require('firebase-admin');
const PROJECT_ID = 'katha-777';
const TIME_ZONE = 'Asia/Kolkata';
const REMINDER_DAYS = new Set([7, 14, 21, 28]);
const APP_URL = 'https://abhishek777f.github.io/katha/#/reports';
const STALE_RUNNING_MS = 30 * 60 * 1000;

function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: out.year, month: out.month, day: out.day, dateKey: `${out.year}-${out.month}-${out.day}` };
}
function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing GitHub secret FIREBASE_SERVICE_ACCOUNT.');
  let sa;
  try { sa = JSON.parse(raw); } catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the complete service-account JSON as the GitHub Actions secret.'); }
  if (sa.project_id !== PROJECT_ID) throw new Error(`Service account project_id must be ${PROJECT_ID}; received ${sa.project_id || '(missing)'}.`);
  return sa;
}
function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function getActiveAdminTokens(db) {
  const adminsSnap = await db.collection('admins').where('active', '==', true).get();
  const tokens = new Map();
  for (const adminDoc of adminsSnap.docs) {
    const tokenSnap = await db.collection('adminPushTokens').doc(adminDoc.id).collection('tokens').get();
    for (const tokenDoc of tokenSnap.docs) {
      const token = tokenDoc.get('token');
      if (typeof token === 'string' && token.trim()) {
        // Keep a token's Firestore path so invalid tokens can be removed.
        tokens.set(token, tokenDoc.ref);
      }
    }
  }
  return [...tokens.entries()].map(([token, ref]) => ({ token, ref }));
}
async function readOutstandingCustomers(db) {
  const snap = await db.collection('customers').get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(c => c.deleted !== true)
    .map(c => ({ ...c, totalPaise: Number(c.totalPaise) || 0, paidPaise: Number(c.paidPaise) || 0 }))
    .filter(c => c.totalPaise - c.paidPaise > 0);
}
async function claimRun(db, dateKey) {
  const ref = db.collection('reminderRuns').doc(dateKey);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = snap.exists ? snap.data() : null;
    if (old && old.status === 'sent') return { claimed: false, reason: 'already sent' };
    if (old && old.status === 'running') {
      const started = old.startedAt && typeof old.startedAt.toMillis === 'function' ? old.startedAt.toMillis() : 0;
      if (started && Date.now() - started < STALE_RUNNING_MS) return { claimed: false, reason: 'another run is in progress' };
    }
    tx.set(ref, {
      status: 'running', dateKey, startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(), projectId: PROJECT_ID
    }, { merge: true });
    return { claimed: true, ref };
  });
}
async function sendToTokens(messaging, tokenRows, customersCount, dateKey) {
  let successCount = 0;
  let failureCount = 0;
  const invalidRefs = [];
  const countText = `${customersCount} customer${customersCount === 1 ? '' : 's'} have an outstanding balance.`;
  for (const batch of chunks(tokenRows, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map(x => x.token),
      notification: {
        title: 'My Katha — Balance Reminder',
        body: countText
      },
      data: {
        type: 'balance_reminder',
        date: dateKey,
        customersCount: String(customersCount),
        url: APP_URL
      },
      webpush: {
        notification: { icon: 'https://abhishek777f.github.io/katha/icon-192.png', tag: `balance-reminder-${dateKey}`, renotify: false },
        fcmOptions: { link: APP_URL }
      }
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
    response.responses.forEach((r, i) => {
      if (!r.success && r.error && [
        'messaging/registration-token-not-registered', 'messaging/invalid-registration-token'
      ].includes(r.error.code)) invalidRefs.push(batch[i].ref);
    });
  }
  await Promise.all(invalidRefs.map(ref => ref.delete().catch(() => {})));
  return { successCount, failureCount, invalidCount: invalidRefs.length };
}

async function main() {
  const serviceAccount = parseServiceAccount();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
  const db = admin.firestore();
  const messaging = admin.messaging();
  const { dateKey, day } = istParts();
  const diagnostic = String(process.env.DIAGNOSTIC_MODE || 'false').toLowerCase() === 'true';

  const [customers, tokens] = await Promise.all([readOutstandingCustomers(db), getActiveAdminTokens(db)]);
  const totalOutstandingPaise = customers.reduce((sum, c) => sum + (c.totalPaise - c.paidPaise), 0);
  console.log(JSON.stringify({ mode: diagnostic ? 'diagnostic' : 'send', projectId: PROJECT_ID, dateKey, day: Number(day), outstandingCustomers: customers.length, totalOutstandingPaise, activeAdminTokens: tokens.length }, null, 2));

  if (diagnostic) {
    console.log('Diagnostic mode: no notifications were sent and no reminder run was claimed.');
    return;
  }
  if (!REMINDER_DAYS.has(Number(day))) {
    console.log(`Today is not a configured reminder day in ${TIME_ZONE}; no notification sent.`);
    return;
  }
  if (customers.length === 0) {
    console.log('No outstanding customer balances; no notification sent.');
    return;
  }
  if (tokens.length === 0) throw new Error('No FCM tokens found for active admins. Open My Katha > Settings and enable push notifications on at least one admin device.');

  const claim = await claimRun(db, dateKey);
  if (!claim.claimed) {
    console.log(`Skipped reminder run: ${claim.reason}.`);
    return;
  }
  try {
    const result = await sendToTokens(messaging, tokens, customers.length, dateKey);
    if (result.successCount < 1) throw new Error(`FCM failed for all tokens (${result.failureCount} failures).`);
    await claim.ref.set({
      status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp(),
      customerCount: customers.length, totalOutstandingPaise,
      tokenCount: tokens.length, successCount: result.successCount,
      failureCount: result.failureCount, invalidTokenCount: result.invalidCount
    }, { merge: true });
    console.log(JSON.stringify({ result: 'sent', ...result, dateKey }, null, 2));
  } catch (error) {
    await claim.ref.set({ status: 'failed', failedAt: admin.firestore.FieldValue.serverTimestamp(), error: String(error.message || error) }, { merge: true });
    throw error;
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
