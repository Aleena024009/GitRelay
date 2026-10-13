// Loaded into the generated service worker (see vite.config.ts). A click on a
// GitRelay notification brings the open app to the front, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) return w.focus()
      }
      return self.clients.openWindow(self.registration.scope)
    }),
  )
})
