/* Install popup: shows on every page load while the app is not installed */
(function () {
  'use strict';

  var APP_NAME = 'My App';
  var LOGO = '/icon-192.png';
  var SHOW_DELAY_MS = 1200;

  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.warn('SW registration failed', e);
      });
    });
  }

  // Already running as an installed app -> never show
  var isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  var ua = navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var deferredPrompt = null;
  var overlay = null;

  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var SHARE = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

  function build() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'pwa-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pwa-title');

    overlay.innerHTML =
      '<div class="pwa-card">' +
        '<img class="pwa-logo" src="' + LOGO + '" alt="' + APP_NAME + ' logo">' +
        '<h2 class="pwa-title" id="pwa-title">Install ' + APP_NAME + '</h2>' +
        '<p class="pwa-sub">Add it to your home screen for a faster, full-screen experience.</p>' +
        '<ul class="pwa-perks">' +
          '<li>' + CHECK + 'Opens instantly, like a native app</li>' +
          '<li>' + CHECK + 'Works offline</li>' +
          '<li>' + CHECK + 'No app store, no extra storage</li>' +
        '</ul>' +
        '<div class="pwa-steps" id="pwa-ios-steps">' +
          '<ol>' +
            '<li>Tap the Share button ' + SHARE + ' in Safari</li>' +
            '<li>Choose <b>Add to Home Screen</b></li>' +
            '<li>Tap <b>Add</b></li>' +
          '</ol>' +
        '</div>' +
        '<button class="pwa-btn primary" id="pwa-install">Install App</button>' +
        '<button class="pwa-btn ghost" id="pwa-later">Not now</button>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.querySelector('#pwa-later').addEventListener('click', hide);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    overlay.querySelector('#pwa-install').addEventListener('click', onInstall);
    return overlay;
  }

  function show() {
    build();
    // next frame so the transition runs
    requestAnimationFrame(function () { overlay.classList.add('show'); });
  }

  function hide() {
    if (overlay) overlay.classList.remove('show');
  }

  function onInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        deferredPrompt = null;
        if (choice.outcome === 'accepted') hide();
      });
    } else if (isIOS) {
      var steps = overlay.querySelector('#pwa-ios-steps');
      steps.classList.add('show');
      overlay.querySelector('#pwa-install').textContent = 'Got it';
      overlay.querySelector('#pwa-install').onclick = hide;
    } else {
      hide();
    }
  }

  // Chrome / Edge / Android: wait for the install event, then show the popup
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(show, SHOW_DELAY_MS);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hide();
  });

  // iOS Safari has no install event, so show the guide on every load
  if (isIOS) {
    window.addEventListener('load', function () { setTimeout(show, SHOW_DELAY_MS); });
  }
})();
