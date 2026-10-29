const admin = require("firebase-admin");

const PROJECT_ID = "katha-777";
const APP_URL = "https://abhishek777f.github.io/katha/#/reports";
const STATE_REF = "paymentPushPoller/state";
const DELIVERY_COLLECTION = "paymentPushDeliveries";
const BATCH_LIMIT = 100;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) fail("Missing FIREBASE_SERVICE_ACCOUNT GitHub secret.");
  try {
    const parsed = JSON.parse(raw);
    if (parsed.project_id !== PROJECT_ID) {
      fail(`Service account project_id must be ${PROJECT_ID}.`);
    }
    return parsed;
  } catch (e) {
    fail(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${e.message}`);
  }
}

function moneyFromPaise(paise) {
  return (Number(paise) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function main() {
  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID,
  });
  const db = admin.firestore();
  const messaging = admin.messaging();
  const stateRef = db.doc(STATE_REF);

  // First run sets a baseline. This deliberately avoids notifying for old
  // payments that existed before this poller was installed.
  let stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    await stateRef.create({
      initializedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      note: "Baseline created; existing payments will not trigger notifications.",
    });
    console.log(JSON.stringify({
      mode: "initialized",
      projectId: PROJECT_ID,
      message: "Baseline saved. No notifications were sent on the first run.",
    }, null, 2));
    return;
  }

  stateSnap = await stateRef.get();
  const initializedAt = stateSnap.get("initializedAt");
  if (!initializedAt || typeof initializedAt.toDate !== "function") {
    fail(`Invalid ${STATE_REF}.initializedAt. Inspect the document before continuing.`);
  }

  const adminsSnap = await db.collection("admins").where("active", "==", true).get();
  const tokensByValue = new Map();
  for (const adminDoc of adminsSnap.docs) {
    const tokenSnap = await db.collection("adminPushTokens")
      .doc(adminDoc.id).collection("tokens").get();
    for (const tokenDoc of tokenSnap.docs) {
      const token = tokenDoc.get("token");
      if (typeof token === "string" && token.trim()) {
        tokensByValue.set(token.trim(), { token: token.trim(), ref: tokenDoc.ref });
      }
    }
  }
  const tokens = [...tokensByValue.values()];

  let scanned = 0;
  let sentPayments = 0;
  let skipped = 0;
  let failures = 0;
  let lastDoc = null;

  // Process payments created since the first-run baseline. Limit batches to
  // avoid unbounded execution. Subsequent workflow runs pick up later docs.
  for (let batchNo = 0; batchNo < 20; batchNo++) {
    let query = db.collection("payments")
      .where("createdAt", ">=", initializedAt)
      .orderBy("createdAt", "asc")
      .orderBy(admin.firestore.FieldPath.documentId(), "asc")
      .limit(BATCH_LIMIT);
    if (lastDoc) query = query.startAfter(lastDoc);

    const batch = await query.get();
    if (batch.empty) break;
    scanned += batch.size;
    lastDoc = batch.docs[batch.docs.length - 1];

    for (const paymentDoc of batch.docs) {
      const payment = paymentDoc.data() || {};
      if (payment.status !== "active") {
        skipped++;
        continue;
      }

      const deliveryRef = db.collection(DELIVERY_COLLECTION).doc(paymentDoc.id);
      const deliverySnap = await deliveryRef.get();
      if (deliverySnap.exists && deliverySnap.get("status") === "sent") {
        skipped++;
        continue;
      }

      const amountPaise = Number(payment.amountPaise);
      if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
        await deliveryRef.set({
          status: "failed",
          reason: "Missing or invalid amountPaise.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        failures++;
        console.error(`Payment ${paymentDoc.id}: invalid amountPaise; skipped.`);
        continue;
      }

      let customerName = "Customer";
      if (payment.customerId) {
        const customerSnap = await db.collection("customers").doc(payment.customerId).get();
        if (customerSnap.exists) customerName = String(customerSnap.get("name") || "Customer");
      }
      const receiptNo = String(payment.receiptNo || paymentDoc.id);

      if (!tokens.length) {
        await deliveryRef.set({
          status: "no_tokens",
          customerName,
          amountPaise,
          receiptNo,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        failures++;
        console.error(`Payment ${paymentDoc.id}: no active administrator tokens.`);
        continue;
      }

      await deliveryRef.set({
        status: "sending",
        customerName,
        amountPaise,
        receiptNo,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const amount = moneyFromPaise(amountPaise);
      const title = "My Katha · Payment Received";
      const body = `${customerName} paid ₹${amount}. Receipt: ${receiptNo}`;

      try {
        const response = await messaging.sendEachForMulticast({
          tokens: tokens.map((x) => x.token),
          notification: { title, body },
          data: {
            type: "payment_received",
            paymentId: paymentDoc.id,
            customerId: String(payment.customerId || ""),
            customerName,
            amountPaise: String(amountPaise),
            receiptNo,
            url: APP_URL,
          },
          webpush: {
            notification: {
              title,
              body,
              icon: "https://abhishek777f.github.io/katha/icon-192.png",
              tag: `payment-${paymentDoc.id}`,
            },
            fcmOptions: { link: APP_URL },
          },
        });

        const invalid = new Set([
          "messaging/invalid-registration-token",
          "messaging/registration-token-not-registered",
        ]);
        const cleanup = [];
        response.responses.forEach((r, i) => {
          if (!r.success && invalid.has(r.error?.code)) cleanup.push(tokens[i].ref.delete());
        });
        await Promise.all(cleanup);

        await deliveryRef.set({
          status: response.successCount > 0 ? "sent" : "failed",
          successCount: response.successCount,
          failureCount: response.failureCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        if (response.successCount > 0) {
          sentPayments++;
          console.log(`Payment ${paymentDoc.id}: FCM accepted by ${response.successCount} token(s); ${response.failureCount} failed.`);
        } else {
          failures++;
          console.error(`Payment ${paymentDoc.id}: FCM rejected every token.`);
        }
      } catch (error) {
        await deliveryRef.set({
          status: "failed",
          error: String(error.message || error).slice(0, 500),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        failures++;
        console.error(`Payment ${paymentDoc.id}: ${error.message || error}`);
      }
    }
  }

  console.log(JSON.stringify({
    mode: "poll",
    projectId: PROJECT_ID,
    baseline: initializedAt.toDate().toISOString(),
    activeAdminTokens: tokens.length,
    paymentDocumentsScanned: scanned,
    paymentNotificationsAccepted: sentPayments,
    skipped: skipped,
    failures: failures,
    note: "FCM acceptance does not guarantee the phone displayed the notification.",
  }, null, 2));

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
                              
