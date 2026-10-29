/* My Katha — PWA cache + Firebase Cloud Messaging worker.
 * Keep this filename as sw.js. App is hosted at /katha/ on GitHub Pages.
 */
'use strict';

const CACHE_NAME = 'my-katha-v5';
const APP_BASE = new URL('./', self.location.href);
const APP_ENTRY = new URL('index.html', APP_BASE);
const APP_HOME = new URL('index.html#/home', APP_BASE).href;
const DEFAULT_NOTIFICATION_URL = new URL('index.html#/reports', APP_BASE).href;

// Handle clicks before importing Firebase Messaging so this handler wins over
// the SDK's default click handler. The app remains inside the /katha/ scope.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const ndata = event.notification && event.notification.data ? event.notification.data : {};
  const fcm = ndata.FCM_MSG || {};
  const payloadData = fcm.data || ndata.data || {};
  let target = payloadData.url || ndata.url || DEFAULT_NOTIFICATION_URL;
  try {
    const parsed = new URL(target, APP_BASE);
    if (parsed.origin !== self.location.origin || !parsed.pathname.startsWith(APP_BASE.pathname)) {
      target = DEFAULT_NOTIFICATION_URL;
    } else {
      target = parsed.href;
    }
  } catch (_) {
    target = DEFAULT_NOTIFICATION_URL;
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        if ('navigate' in client) await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

importScripts('https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCM_GbroLBZ0GbYmBKge7e4vAn77aLe0PA',
  authDomain: 'katha-777.firebaseapp.com',
  projectId: 'katha-777',
  storageBucket: 'katha-777.firebasestorage.app',
  messagingSenderId: '99260944187',
  appId: '1:99260944187:web:278b72f27fdbb2032fb11e'
});

const messaging = firebase.messaging();

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new Request(APP_ENTRY.href, { cache: 'reload' }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('my-katha-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Network-first for same-origin GETs. Never intercept Firebase/API POSTs or
// cross-origin SDK requests. Cache successful same-origin responses only.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_BASE.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const entry = await caches.match(APP_ENTRY.href);
        if (entry) return entry;
      }
      return new Response('You are offline. Please reconnect and try again.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});

// Notification payloads are displayed by Firebase Messaging automatically.
// For data-only messages, display the notification here.
messaging.onBackgroundMessage(payload => {
  if (payload && payload.notification) return;
  const data = (payload && payload.data) || {};
  const title = data.title || 'My Katha';
  const options = {
    body: data.body || 'You have a balance reminder.',
    icon: new URL('icon-192.png', APP_BASE).href,
    badge: new URL('icon-192.png', APP_BASE).href,
    data: { url: data.url || DEFAULT_NOTIFICATION_URL },
    tag: data.tag || data.type || 'my-katha-notification',
    renotify: false
  };
  return self.registration.showNotification(title, options);
});
     
