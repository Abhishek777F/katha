"use strict";

const admin = require("firebase-admin");

const PROJECT_ID = "katha-777";
const INDIA_TIME_ZONE = "Asia/Kolkata";
const SCHEDULED_DAYS = [7, 14, 21, 28];

function fail(message) {
  throw new Error(message);
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    fail("GitHub Secret FIREBASE_SERVICE_ACCOUNT is missing.");
  }

  let account;

  try {
    account = JSON.parse(raw);
  } catch {
    fail("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }

  if (
    !account.project_id ||
    !account.client_email ||
    !account.private_key
  ) {
    fail("The service-account JSON is missing required fields.");
  }

  if (account.project_id !== PROJECT_ID) {
    fail("The service account does not belong to katha-777.");
  }

  return account;
}

function getIndiaDateParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

async function main() {
  const diagnostic = process.env.DIAGNOSTIC_MODE === "true";
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

  console.log("Khata Management balance reminder");
  console.log("Project:", PROJECT_ID);
  console.log("India date:", dateKey);
  console.log("Mode:", diagnostic ? "DIAGNOSTIC — NO PUSH" : "SCHEDULED");

  // Read customers without changing their records.
  const customerSnapshot = await db.collection("customers")
    .where("deleted", "==", false)
    .get();

  let outstandingCustomers = 0;
  let totalOutstandingPaise = 0;
  let recordsWithoutExpectedFields = 0;

  for (const doc of customerSnapshot.docs) {
    const data = doc.data();

    if (
      !Number.isSafeInteger(data.totalPaise) ||
      !Number.isSafeInteger(data.paidPaise)
    ) {
      recordsWithoutExpectedFields++;
      continue;
    }

    if (data.totalPaise > data.paidPaise) {
      outstandingCustomers++;
      totalOutstandingPaise += data.totalPaise - data.paidPaise;
    }
  }

  // Find active admins and their registered device tokens.
  const adminsSnapshot = await db.collection("admins")
    .where("active", "==", true)
    .get();

  const tokens = new Set();

  for (const adminDoc of adminsSnapshot.docs) {
    const tokenSnapshot = await db
      .collection("adminPushTokens")
      .doc(adminDoc.id)
      .collection("tokens")
      .get();

    for (const tokenDoc of tokenSnapshot.docs) {
      const token = tokenDoc.get("token");

      if (typeof token === "string" && token.length > 20) {
        tokens.add(token);
      }
    }
  }

  console.log(JSON.stringify({
    date: dateKey,
    activeCustomers: customerSnapshot.size,
    customersWithOutstandingBalances: outstandingCustomers,
    totalOutstandingRupees: (totalOutstandingPaise / 100).toFixed(2),
    recordsMissingExpectedBalanceFields: recordsWithoutExpectedFields,
    activeAdmins: adminsSnapshot.size,
    registeredDeviceTokens: tokens.size
  }, null, 2));

  // Diagnostic mode never sends a push or modifies Firestore.
  if (diagnostic) {
    console.log("DIAGNOSTIC PASSED: Firebase reads succeeded.");
    console.log("No notification was sent.");
    return;
  }

  if (!SCHEDULED_DAYS.includes(day)) {
    console.log("No reminder is scheduled today.");
    return;
  }

  if (outstandingCustomers === 0 || totalOutstandingPaise <= 0) {
    console.log("No outstanding balances. No push was sent.");
    return;
  }

  if (tokens.size === 0) {
    fail("No registered admin device tokens were found.");
  }

  // Avoid duplicate scheduled sends for this date.
  const runRef = db.collection("reminderRuns").doc(dateKey);

  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(runRef);

    if (
      snapshot.exists &&
      ["sent", "running"].includes(snapshot.get("status"))
    ) {
      return false;
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
    console.log("A reminder run already exists for this date.");
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  try {
    for (const token of tokens) {
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
        console.error(
          "Push failed:",
          error && error.code ? error.code : "unknown error"
        );
      }
    }

    await runRef.set({
      status: successCount > 0 ? "sent" : "failed",
      result: "push_attempted",
      outstandingCustomers,
      totalOutstandingPaise,
      registeredDevices: tokens.size,
      successfulDevices: successCount,
      failedDevices: failureCount,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(JSON.stringify({
      registeredDevices: tokens.size,
      successfulDevices: successCount,
      failedDevices: failureCount
    }, null, 2));

    if (successCount === 0) {
      fail("Firebase did not accept any push notifications.");
    }
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
  console.error("Balance reminder job failed:", error.message || error);
  process.exitCode = 1;
});
