/* Yalla — service worker, for the daily reminder only.
 *
 * Android only lets a page show a notification through a service worker, and a
 * tapped notification should bring the app forward. That is all this does: it
 * has no fetch handler and caches nothing, so the app is never served stale. */
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = wins.find(c => c.url.startsWith(self.registration.scope));
    return app ? app.focus() : self.clients.openWindow(self.registration.scope);
  })());
});
