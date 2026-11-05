'use strict';

const admin = require('firebase-admin');

const PROJECT_ID = 'katha-777';
const COLLECTION = 'customerNotifications';
const BATCH_LIMIT = 20;
const PROCESS_CONCURRENCY = 5;
const MAX_RUN_MS = 4 * 60 * 1000;
const CURSOR_COLLECTION = 'customerNotificationWorkerState';
const STALE_SENDING_MS = 15 * 60 * 1000;
const TOKEN_COLLECTION = 'customerPushTokens';

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing GitHub secret FIREBASE_SERVICE_ACCOUNT.');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (serviceAccount.project_id !== PROJECT_ID) {
    throw new Error(`Service account project_id must be ${PROJECT_ID}; received ${serviceAccount.project_id || '(missing)'}.`);
  }
  return serviceAccount;
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function claimNotification(db, ref) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, reason: 'document missing' };
    const data = snap.data() || {};
    const status = data.status;
    if (status === 'sent' || status === 'failed') return { claimed: false, reason: `already ${status}` };
    if (status === 'sending') {
      const started = data.processingAt && typeof data.processingAt.toMillis === 'function'
        ? data.processingAt.toMillis() : 0;
      if (started && Date.now() - started < STALE_SENDING_MS) {
        return { claimed: false, reason: 'another run is processing it' };
      }
    } else if (status !== 'pending') {
      return { claimed: false, reason: `unsupported status ${String(status)}` };
    }
    tx.update(ref, {
      status: 'sending',
      attempts: (Number(data.attempts) || 0) + 1,
      processingAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { claimed: true };
  });
}

async function getCustomerTokens(db, customerId) {
  // Resolve only identities whose immutable customerLinks claim matches this
  // notification's customerId. Never read or send to other customers' tokens.
  const links = await db.collection('customerLinks').where('customerId', '==', customerId).get();
  const unique = new Map();
  for (const link of links.docs) {
    const tokenSnap = await db.collection(TOKEN_COLLECTION).doc(link.id).collection('tokens').get();
    for (const tokenDoc of tokenSnap.docs) {
      const token = tokenDoc.get('token');
      if (typeof token === 'string' && token.trim()) {
        unique.set(token.trim(), tokenDoc.ref);
      }
    }
  }
  return [...unique.entries()].map(([token, ref]) => ({ token, ref }));
}

async function sendToCustomer(messaging, notification, tokenRows) {
  let successCount = 0;
  let failureCount = 0;
  const invalidRefs = [];
  const invalidCodes = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token'
  ]);

  for (const batch of chunks(tokenRows, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map(row => row.token),
      data: {
        type: 'custom_message',
        customerNotificationId: notification.id,
        customerId: notification.customerId,
        title: notification.title,
        body: notification.body
      },
      // Data-only, high-priority Android delivery lets the installed app's
      // FirebaseMessagingService display the branded My Katha notification.
      android: { priority: 'high', ttl: 60 * 60 * 1000 }
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
    response.responses.forEach((result, index) => {
      if (!result.success && result.error && invalidCodes.has(result.error.code)) {
        invalidRefs.push(batch[index].ref);
      }
    });
  }

  await Promise.all(invalidRefs.map(ref => ref.delete().catch(() => {})));
  return { successCount, failureCount, invalidTokenCount: invalidRefs.length };
}

async function processOne(db, messaging, docSnap) {
  const ref = docSnap.ref;
  const claim = await claimNotification(db, ref);
  if (!claim.claimed) {
    console.log(`Notification ${docSnap.id}: skipped (${claim.reason}).`);
    return;
  }

  const data = docSnap.data() || {};
  const customerId = typeof data.customerId === 'string' ? data.customerId.trim() : '';
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const body = typeof data.body === 'string' ? data.body.trim() : '';

  if (!customerId || !title || !body || title.length > 80 || body.length > 1000) {
    await ref.set({
      status: 'failed',
      lastError: 'Missing or invalid customerId, title, or body.',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.error(`Notification ${docSnap.id}: invalid message data.`);
    return;
  }

  try {
    const tokens = await getCustomerTokens(db, customerId);
    if (!tokens.length) {
      // Keep it pending so a customer who registers FCM later can receive it.
      await ref.set({
        status: 'pending',
        lastError: 'No FCM tokens are registered for this customer yet.',
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        processingAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`Notification ${docSnap.id}: waiting; no tokens for ${customerId}.`);
      return;
    }

    const result = await sendToCustomer(messaging, {
      id: docSnap.id, customerId, title, body
    }, tokens);

    if (result.successCount > 0) {
      await ref.set({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        tokenCount: tokens.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
        invalidTokenCount: result.invalidTokenCount,
        lastError: admin.firestore.FieldValue.delete(),
        processingAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`Notification ${docSnap.id}: FCM accepted by ${result.successCount} token(s) for customer ${customerId}; ${result.failureCount} failed.`);
    } else {
      await ref.set({
        status: 'pending',
        lastError: `FCM rejected all ${result.failureCount} token(s).`,
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        tokenCount: tokens.length,
        successCount: 0,
        failureCount: result.failureCount,
        invalidTokenCount: result.invalidTokenCount,
        processingAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.error(`Notification ${docSnap.id}: no token accepted; it will be retried.`);
    }
  } catch (error) {
    await ref.set({
      status: 'pending',
      lastError: String(error.message || error).slice(0, 500),
      lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      processingAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.error(`Notification ${docSnap.id}: ${error.message || error}; it will be retried.`);
  }
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID
    });
  }
  const db = admin.firestore();
  const messaging = admin.messaging();
  const stateRef = db.collection(CURSOR_COLLECTION).doc('customMessages');
  const stateSnap = await stateRef.get();
  let lastDocumentId = stateSnap.exists ? stateSnap.get('lastDocumentId') : null;
  let cursorSnapshot = null;

  // Resume after the last fully processed group from the previous run.
  // The cursor document can already be "sent"; it is used only as a position.
  if (typeof lastDocumentId === 'string' && lastDocumentId) {
    const savedCursor = await db.collection(COLLECTION).doc(lastDocumentId).get();
    if (savedCursor.exists) {
      cursorSnapshot = savedCursor;
    } else {
      lastDocumentId = null;
      await stateRef.set({
        lastDocumentId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }

  const startedAt = Date.now();
  let scanned = 0;
  let processed = 0;
  let cycleCompleted = false;
  let timeBudgetReached = false;

  while (Date.now() - startedAt < MAX_RUN_MS) {
    let query = db.collection(COLLECTION)
      .where('status', 'in', ['pending', 'sending'])
      .limit(BATCH_LIMIT);

    if (cursorSnapshot) query = query.startAfter(cursorSnapshot);

    const snapshot = await query.get();
    if (snapshot.empty) {
      // We reached the end of the queue. The next scheduled run starts at
      // the beginning, so messages created behind the cursor are not lost.
      await stateRef.set({
        lastDocumentId: admin.firestore.FieldValue.delete(),
        cycleCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      cycleCompleted = true;
      break;
    }

    scanned += snapshot.size;
    for (let i = 0; i < snapshot.docs.length; i += PROCESS_CONCURRENCY) {
      const group = snapshot.docs.slice(i, i + PROCESS_CONCURRENCY);
      await Promise.all(group.map(docSnap => processOne(db, messaging, docSnap)));
      processed += group.length;

      // Persist the cursor only after this group has finished. If a run stops
      // unexpectedly, the next run resumes safely from the previous group.
      const lastDoc = group[group.length - 1];
      await stateRef.set({
        lastDocumentId: lastDoc.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      cursorSnapshot = lastDoc;

      if (Date.now() - startedAt >= MAX_RUN_MS) {
        timeBudgetReached = true;
        break;
      }
    }

    if (timeBudgetReached) break;
  }

  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    scanned,
    processed,
    cycleCompleted,
    timeBudgetReached,
    nextCursor: cursorSnapshot ? cursorSnapshot.id : null,
    note: 'The worker resumes from its saved cursor on the next run. FCM acceptance confirms provider acceptance, not that a phone displayed the notification.'
  }, null, 2));
}
main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
