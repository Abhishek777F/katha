const PROJECT_ID = "katha-777";
const FIREBASE_API_KEY = "AIzaSyCMG_broLBZ0GbYmBKge7e4vAn77aLe0PA";
const ALLOWED_ORIGIN = "https://abhishek777f.github.io";
const ALLOWED_NOTIFICATION_TYPES = ["custom_message", "loan_created", "payment_received"];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : "null",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}
function response(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pemBytes(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(clean), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + "." + claim;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(signature);
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await result.json();
  if (!result.ok || !data.access_token) throw new Error("Google authentication failed: " + JSON.stringify(data));
  return data.access_token;
}
async function googleRequest(url, token, options = {}) {
  const result = await fetch(url, {
    ...options,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await result.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!result.ok) throw new Error("Google API " + result.status + ": " + text.slice(0, 700));
  return data;
}
function field(doc, name) {
  const f = doc && doc.fields && doc.fields[name];
  if (!f) return undefined;
  if ("stringValue" in f) return f.stringValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("timestampValue" in f) return f.timestampValue;
  return undefined;
}
function fsString(value) { return { stringValue: String(value) }; }
function fsTimestamp(value = new Date()) { return { timestampValue: value.toISOString() }; }
function fsInteger(value) { return { integerValue: String(value) }; }
function documentUrl(collection, id) {
  return "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents/" + collection + "/" + encodeURIComponent(id);
}
async function verifyAdmin(idToken, accessToken) {
  const lookup = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  const account = await lookup.json(), user = account.users && account.users[0];
  if (!lookup.ok || !user || user.disabled === true) throw new Error("Your Firebase login is invalid or disabled. Please sign in again.");
  const uid = user.localId;
  const adminDoc = await googleRequest(documentUrl("admins", uid), accessToken);
  if (field(adminDoc, "active") !== true) throw new Error("This account is not an active My Katha admin.");
  return uid;
}
async function getNotification(id, accessToken) {
  return googleRequest(documentUrl("customerNotifications", id), accessToken);
}
async function patchNotification(id, updateTime, fields, accessToken) {
  const url = new URL(documentUrl("customerNotifications", id));
  for (const key of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", key);
  url.searchParams.set("currentDocument.updateTime", updateTime);
  return googleRequest(url.toString(), accessToken, {
    method: "PATCH",
    body: JSON.stringify({ fields })
  });
}
async function findCustomerLinks(customerId, accessToken) {
  const url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents:runQuery";
  const result = await googleRequest(url, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "customerLinks" }],
        where: { fieldFilter: { field: { fieldPath: "customerId" }, op: "EQUAL", value: fsString(customerId) } }
      }
    })
  });
  return result.map(row => row.document).filter(Boolean);
}
async function customerIsOnline(uid, customerId, accessToken) {
  try {
    const presence = await googleRequest(documentUrl("customerPresence", uid), accessToken);
    return field(presence, "online") === true && field(presence, "customerId") === customerId;
  } catch (_) {
    return false;
  }
}
async function getTokens(uid, accessToken) {
  const url = documentUrl("customerPushTokens", uid) + "/tokens";
  const result = await googleRequest(url, accessToken);
  return (result.documents || []).map(doc => field(doc, "token"))
    .filter(token => typeof token === "string" && token.trim());
}
async function sendFCM(token, message, accessToken) {
  const url = "https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send";
  return googleRequest(url, accessToken, {
    method: "POST",
    body: JSON.stringify({
      message: {
        token,
        data: {
          type: message.type,
          customerNotificationId: message.id,
          customerId: message.customerId,
          title: message.title,
          body: message.body
        },
        android: { priority: "HIGH", ttl: "3600s" }
      }
    })
  });
}
async function handleSend(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (origin !== ALLOWED_ORIGIN) return response({ error: "Origin not allowed." }, 403, origin);
  const authorization = request.headers.get("Authorization") || "";
  const idToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!idToken) return response({ error: "Missing Firebase login token." }, 401, origin);
  let input;
  try { input = await request.json(); } catch (_) { return response({ error: "Invalid JSON request." }, 400, origin); }
  const notificationId = String(input.notificationId || "").trim();
  if (!/^[A-Za-z0-9_-]{10,150}$/.test(notificationId)) return response({ error: "Invalid notification ID." }, 400, origin);

  try {
    const raw = env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("Cloudflare Firebase secret is missing.");
    const sa = JSON.parse(raw);
    if (sa.project_id !== PROJECT_ID || !sa.client_email || !sa.private_key) {
      throw new Error("Firebase service-account configuration is invalid.");
    }
    const accessToken = await getAccessToken(sa);
    const uid = await verifyAdmin(idToken, accessToken);
    const doc = await getNotification(notificationId, accessToken);
    const data = {
      id: notificationId,
      customerId: field(doc, "customerId"),
      title: field(doc, "title"),
      body: field(doc, "body"),
      type: field(doc, "type"),
      status: field(doc, "status"),
      createdBy: field(doc, "createdBy")
    };
    if (data.createdBy !== uid) return response({ error: "You did not create this notification." }, 403, origin);
    if (!ALLOWED_NOTIFICATION_TYPES.includes(data.type)) return response({ error: "Unsupported notification type." }, 400, origin);
    if (data.status === "sent") return response({ success: true, status: "already_sent" }, 200, origin);
    if (data.status !== "pending") return response({ error: "Notification status is " + (data.status || "unknown") + "." }, 409, origin);
    if (!data.customerId || !data.title || !data.body || data.title.length > 80 || data.body.length > 1000) {
      throw new Error("Notification data is incomplete or invalid.");
    }

    try {
      await patchNotification(notificationId, doc.updateTime, {
        status: fsString("sending"),
        processingAt: fsTimestamp(),
        attempts: fsInteger(1),
        updatedAt: fsTimestamp()
      }, accessToken);
    } catch (error) {
      return response({ error: "Could not claim this message. It may already be processing.", detail: error.message }, 409, origin);
    }

    try {
      const links = await findCustomerLinks(data.customerId, accessToken);
      const onlineUids = [];
      for (const link of links) {
        const customerUid = link.name.split("/").pop();
        if (await customerIsOnline(customerUid, data.customerId, accessToken)) onlineUids.push(customerUid);
      }

      if (!onlineUids.length) {
        const current = await getNotification(notificationId, accessToken);
        await patchNotification(notificationId, current.updateTime, {
          status: fsString("pending"),
          lastError: fsString("Customer is offline. Notification is waiting for the next login."),
          updatedAt: fsTimestamp()
        }, accessToken);
        return response({ success: false, status: "offline", message: "Notification queued until customer logs in." }, 200, origin);
      }

      const tokens = [];
      for (const customerUid of onlineUids) {
        tokens.push(...await getTokens(customerUid, accessToken));
      }
      const uniqueTokens = [...new Set(tokens)];
      if (!uniqueTokens.length) {
        const current = await getNotification(notificationId, accessToken);
        await patchNotification(notificationId, current.updateTime, {
          status: fsString("pending"),
          lastError: fsString("No registered device token for the logged-in customer."),
          updatedAt: fsTimestamp()
        }, accessToken);
        return response({ success: false, status: "no_tokens" }, 200, origin);
      }

      let successCount = 0, failureCount = 0;
      for (const token of uniqueTokens) {
        try {
          // Recheck login state immediately before sending, so a logout stops subsequent sends.
          let stillOnline = false;
          for (const customerUid of onlineUids) {
            if (await customerIsOnline(customerUid, data.customerId, accessToken)) { stillOnline = true; break; }
          }
          if (!stillOnline) { failureCount++; continue; }
          await sendFCM(token, data, accessToken);
          successCount++;
        } catch (_) { failureCount++; }
      }

      const current = await getNotification(notificationId, accessToken);
      if (successCount > 0) {
        await patchNotification(notificationId, current.updateTime, {
          status: fsString("sent"),
          sentAt: fsTimestamp(),
          successCount: fsInteger(successCount),
          failureCount: fsInteger(failureCount),
          updatedAt: fsTimestamp()
        }, accessToken);
        return response({ success: true, status: "sent", type: data.type, successCount, failureCount }, 200, origin);
      }

      await patchNotification(notificationId, current.updateTime, {
        status: fsString("pending"),
        lastError: fsString("Customer went offline or FCM did not accept any device token."),
        failureCount: fsInteger(failureCount),
        updatedAt: fsTimestamp()
      }, accessToken);
      return response({ success: false, status: "pending", failureCount }, 502, origin);
    } catch (error) {
      const current = await getNotification(notificationId, accessToken).catch(() => null);
      if (current && current.updateTime) {
        await patchNotification(notificationId, current.updateTime, {
          status: fsString("pending"),
          lastError: fsString(String(error.message || error).slice(0, 450)),
          updatedAt: fsTimestamp()
        }, accessToken).catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    return response({ error: String(error.message || error).slice(0, 700) }, 500, origin);
  }
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET") {
      return response({
        service: "My Katha notification sender",
        project: PROJECT_ID,
        status: "ready",
        supportedTypes: ALLOWED_NOTIFICATION_TYPES,
        presenceCheck: true
      }, 200, origin);
    }
    if (request.method !== "POST") return response({ error: "Method not allowed." }, 405, origin);
    return handleSend(request, env);
  }
};
