/* Khata Management — background Firebase Cloud Messaging worker. */
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyCM_GbroLBZ0GbYmBKge7e4vAn77aLe0PA",
  authDomain: "katha-777.firebaseapp.com",
  projectId: "katha-777",
  storageBucket: "katha-777.firebasestorage.app",
  messagingSenderId: "99260944187",
  appId: "1:99260944187:web:278b72f27fdbb2032fb11e"
});
const messaging = firebase.messaging();
// Notification payloads are displayed automatically in the background.
// Do not call showNotification() here, which would create duplicates.
messaging.onBackgroundMessage(payload => {
  console.log("[Khata] Background balance reminder received.", payload?.messageId || "");
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const appBase = self.location.href.replace(/firebase-messaging-sw\.js(?:\?.*)?$/, "");
  const targetUrl = appBase + "#/reports";
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if (client.url.startsWith(appBase) && "focus" in client) {
        await client.focus();
        client.navigate(targetUrl);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(targetUrl);
  })());
});
