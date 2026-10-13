/**
 * System notifications, on a phone with the PWA installed and on a laptop.
 *
 * GitRelay has no server, so nothing can push to a closed app. Notifications
 * come from the app itself while it is open — in a tab, in the background, or
 * minimised — when its periodic refresh sees something change on GitHub.
 *
 * Whether they are on is a per-device choice, so it lives in localStorage
 * like the repository settings. It holds a boolean, never anything secret.
 */
import { useCallback, useEffect, useState } from 'react'

const NOTIFY_KEY = 'gitrelay.notify.v1'

export type NotifyPermission = NotificationPermission | 'unsupported'

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function permission(): NotifyPermission {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1'
  } catch {
    return false
  }
}

function saveEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(NOTIFY_KEY, '1')
    else localStorage.removeItem(NOTIFY_KEY)
  } catch {
    /* storage unavailable; the choice lasts for this session only */
  }
}

/** True when notifications are switched on here and the browser allows them. */
export function notificationsActive(): boolean {
  return loadEnabled() && permission() === 'granted'
}

/**
 * Shows one system notification. A `tag` replaces an earlier notification
 * with the same tag instead of stacking a second copy of the same news.
 *
 * Through the service worker when there is one: Android only shows
 * notifications that way, and it lets a click bring the app back to front.
 */
export async function showNotification(title: string, body: string, tag?: string): Promise<void> {
  if (!notificationsActive()) return
  const options: NotificationOptions = {
    body,
    tag,
    icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
    badge: `${import.meta.env.BASE_URL}icons/icon-192.png`,
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, options)
      return
    }
  } catch {
    /* fall through to a page notification */
  }
  try {
    const n = new Notification(title, options)
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* this browser will not show one from a page; nothing else to try */
  }
}

/** The notification switch, for the settings screen and the refresh loop. */
export function useNotifications() {
  const [enabled, setEnabled] = useState(() => notificationsActive())
  const [perm, setPerm] = useState<NotifyPermission>(() => permission())

  // Permission can be revoked from the browser's own site settings while the
  // app is open; pick that up whenever the app comes back into view.
  useEffect(() => {
    const sync = () => {
      setPerm(permission())
      setEnabled(notificationsActive())
    }
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  const enable = useCallback(async () => {
    if (!notificationsSupported()) return
    const result = await Notification.requestPermission()
    setPerm(result)
    if (result !== 'granted') return
    saveEnabled(true)
    setEnabled(true)
    await showNotification(
      'Notifications are on',
      'GitRelay will tell you about new commits, conflicts and releases while it is open.',
      'gitrelay-enabled',
    )
  }, [])

  const disable = useCallback(() => {
    saveEnabled(false)
    setEnabled(false)
  }, [])

  return { enabled, permission: perm, enable, disable }
}
