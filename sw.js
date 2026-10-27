/* =========================================================
   MY KATHA — PWA SERVICE WORKER + FIREBASE MESSAGING
   App: https://abhishek777f.github.io/katha/
   Firebase project: katha-777
   ========================================================= */

"use strict";

/* ---------- FIREBASE COMPAT SDK ---------- */

importScripts(
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js"
);

/* ---------- FIREBASE CONFIGURATION ---------- */

firebase.initializeApp({
  apiKey: "AIzaSyCM_GbroLBZ0GbYmBKge7e4vAn77aLe0PA",
  authDomain: "katha-777.firebaseapp.com",
  projectId: "katha-777",
  storageBucket: "katha-777.firebasestorage.app",
  messagingSenderId: "99260944187",
  appId: "1:99260944187:web:278b72f27fdbb2032fb11e"
});

const messaging = firebase.messaging();

/* ---------- PWA CONFIGURATION ---------- */

const CACHE_NAME = "my-katha-v4";

const APP_BASE = new URL("./", self.location.href);

const APP_ENTRY = new URL("index.html", APP_BASE);

const APP_HOME = new URL("#/home", APP_ENTRY);

const APP_REPORTS = new URL("#/reports", APP_ENTRY);

/* ---------- INSTALL ---------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      await cache.addAll([
        APP_BASE.href,
        APP_ENTRY.href
      ]);

      await self.skipWaiting();
    })()
  );
});

/* ---------- ACTIVATE ---------- */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith("my-katha-") &&
              key !== CACHE_NAME
          )
          .map((key) => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

/* ---------- FETCH / OFFLINE SUPPORT ---------- */

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const requestURL = new URL(request.url);

  // Do not intercept external Firebase or other third-party requests.
  if (requestURL.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);

        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);

          await cache.put(request, response.clone());
        }

        return response;
      } catch (error) {
        const cachedResponse = await caches.match(request);

        if (cachedResponse) {
          return cachedResponse;
        }

        // Keep the app shell available when possible.
        if (request.mode === "navigate") {
          const cachedHome = await caches.match(APP_BASE.href);

          if (cachedHome) {
            return cachedHome;
          }

          const cachedEntry = await caches.match(APP_ENTRY.href);

          if (cachedEntry) {
            return cachedEntry;
          }
        }

        return new Response(
          "My Katha is offline. Please reconnect to the internet.",
          {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      }
    })()
  );
});

/* ---------- FIREBASE BACKGROUND MESSAGES ---------- */

/*
 * Firebase automatically displays notification payloads
 * containing a notification object in the background.
 *
 * Do not call showNotification() here for those same
 * payloads, because that could create duplicate notifications.
 */

messaging.onBackgroundMessage((payload) => {
  console.log(
    "[My Katha] Background message received:",
    payload?.messageId || "message received"
  );
});

/* ---------- NOTIFICATION CLICK ---------- */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // The app is deployed in the /katha/ GitHub Pages directory.
  const appBase = new URL("./", self.location.href);

  const targetURL = new URL("index.html#/reports", appBase);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const client of windows) {
        const clientURL = new URL(client.url);

        if (
          clientURL.origin === appBase.origin &&
          clientURL.pathname.startsWith(appBase.pathname) &&
          "focus" in client
        ) {
          await client.focus();

          if ("navigate" in client) {
            await client.navigate(targetURL.href);
          }

          return;
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetURL.href);
      }
    })()
  );
});
