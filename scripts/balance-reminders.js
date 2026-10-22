"use strict";

const admin = require("firebase-admin");
const crypto = require("crypto");

const PROJECT_ID = "katha-777";
const INDIA_TIME_ZONE = "Asia/Kolkata";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    fail("GitHub Secret FIREBASE_SERVICE_ACCOUNT is not configured.");
  }

  try {
    const account = JSON.parse(raw);

    if (
      !account.project_id ||
      !account.client_email ||
      !account.private_key
    ) {
      fail("The service-account JSON is missing required fields.");
    }

    if (account.project_id !== PROJECT_ID) {
      fail("The service account does not belong to project katha-777.");
    }

    return account;
  } catch (error) {
    if (error.message.startsWith("ERROR:")) throw error;
    fail("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }
}

function getIndiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function main() {
  const serviceAccount = getServiceAccount();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID
  });

  const db = admin.firestore();
  const messaging = admin.messaging();

  const date = getIndiaDateParts();
  const day = Number(date.day);
  const dateKey = `${date.year}-${date.month}-${date.day}`;

  if (![7, 14, 21, 28].includes(day)) {
    console.log(`Today is ${dateKey} in India. No reminder is scheduled.`);
    return;
  }

  /*
   * A single run per scheduled date prevents duplicate notifications.
   * This uses the backend Admin SDK, not client-side Firestore rules.
   */
  const runRef = db.collection("reminderRuns").doc(dateKey);

  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(runRef);

    if (snapshot.exists && snapshot.get("status") === "sent") {
      return false;
    }

    if (snapshot.exists && snapshot.get("status") === "running") {
      const startedAt = snapshot.get("startedAt");
      const age = startedAt && startedAt.toDate
        ? Date.now() - startedAt.toDate().getTime()
        : 0;

      if (age >= 0 && age < 30 * 60 * 1000) {
        return false;
      }
    }

    transaction.set(runRef, {
      status: "running",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      scheduleDate: dateKey,
      timezone: INDIA_TIME_ZONE
    });

    return true;
  });

  if (!claim) {
    console.log(`A reminder run already exists for ${dateKey}.`);
    return;
  }

  try {
    /*
     * Check the actual fields used by Khata Management.
     * Do not send customer names or phone numbers in push notifications.
     */
    const customerSnapshot = await db.collection("customers")
      .where("deleted", "==", false)
      .get();

    let outstandingCustomers = 0;
    let totalOutstandingPaise = 0;

    for (const doc of customerSnapshot.docs) {
      const data = doc.data();

      if (
        Number.isSafeInteger(data.totalPaise) &&
        Number.isSafeInteger(data.paidPaise) &&
        data.totalPaise > data.paidPaise
      ) {
        outstandingCustomers++;
        totalOutstandingPaise += data.totalPaise - data.paidPaise;
      }
    }

    if (outstandingCustomers === 0 || totalOutstandingPaise <= 0) {
      await runRef.set({
        status: "sent",
        result: "no_outstanding_balance",
        outstandingCustomers: 0,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log("No outstanding customer balances. No push was sent.");
      return;
    }

    /*
     * Read only active admins' device tokens.
     * Token documents are stored under:
     * adminPushTokens/{adminUid}/tokens/{tokenHash}
     */
    const adminsSnapshot = await db.collection("admins")
      .where("active", "==", true)
      .get();

    const tokensByValue = new Map();

    for (const adminDoc of adminsSnapshot.docs) {
      const tokenSnapshot = await db
        .collection("adminPushTokens")
        .doc(adminDoc.id)
        .collection("tokens")
        .get();

      for (const tokenDoc of tokenSnapshot.docs) {
        const token = tokenDoc.get("token");

        if (typeof token === "string" && token.length > 20) {
          tokensByValue.set(token, {
            uid: adminDoc.id,
            ref: tokenDoc.ref
          });
        }
      }
    }

    const entries = [...tokensByValue.entries()];

    if (entries.length === 0) {
      await runRef.set({
        status: "failed",
        result: "no_registered_admin_devices",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      fail("No registered admin push tokens were found.");
    }

    let successCount = 0;
    let failureCount = 0;
    const invalidTokenRefs = [];

    /*
     * Send individual messages so invalid tokens can be removed safely.
     */
    for (const [token, entry] of entries) {
      try {
        await messaging.send({
          token,
          notification: {
            title: "Khata Management — Balance Reminder",
            body: `${outstandingCustomers} customer(s) have outstanding balances. Open Khata Management to review them.`
          },
          data: {
            type: "balance_reminder",
            date: dateKey,
            url: "https://abhishek777f.github.io/katha/#/reports"
          },
          webpush: {
            fcmOptions: {
              link: "https://abhishek777f.github.io/katha/#/reports"
            }
          }
        });

        successCount++;
      } catch (error) {
        failureCount++;

        const code = error && error.code ? error.code : "";

        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          invalidTokenRefs.push(entry.ref);
        }

        console.error(`Push failed for one registered device: ${code || "unknown error"}`);
      }
    }

    for (const ref of invalidTokenRefs) {
      await ref.delete().catch(() => {});
    }

    await runRef.set({
      status: successCount > 0 ? "sent" : "failed",
      result: "push_attempted",
      outstandingCustomers,
      totalOutstandingPaise,
      registeredDevices: entries.length,
      successfulDevices: successCount,
      failedDevices: failureCount,
      invalidTokensRemoved: invalidTokenRefs.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(JSON.stringify({
      date: dateKey,
      outstandingCustomers,
      registeredDevices: entries.length,
      successfulDevices: successCount,
      failedDevices: failureCount
    }));
  } catch (error) {
    await runRef.set({
      status: "failed",
      error: String(error.message || error).slice(0, 500),
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    throw error;
  }
}

main().catch(error => {
  console.error("Balance reminder job failed:", error);
  process.exitCode = 1;
});
