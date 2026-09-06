import { useCallback, useEffect, useState } from 'react'

/** Chromium fires this instead of installing, letting the page choose when to ask. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type Platform = 'android' | 'ios' | 'macos' | 'windows' | 'linux' | 'unknown'
export type Browser = 'chromium' | 'firefox' | 'safari' | 'unknown'

export function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  // iPadOS reports as Macintosh, so a touch-capable "Mac" is really an iPad.
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh/i.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'macos'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux'
  return 'unknown'
}

export function detectBrowser(): Browser {
  const ua = navigator.userAgent
  if (/Firefox\//i.test(ua)) return 'firefox'
  if (/Edg\/|Chrome\/|Chromium\/|CriOS\//i.test(ua)) return 'chromium'
  if (/Safari\//i.test(ua)) return 'safari'
  return 'unknown'
}

function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    // iOS Safari predates display-mode and uses a non-standard flag.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export interface InstallState {
  /** True once Chromium has offered a prompt we can replay on demand. */
  canPrompt: boolean
  isInstalled: boolean
  platform: Platform
  browser: Browser
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
}

export function useInstall(): InstallState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(standalone)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferred(null)
      setIsInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)

    const mq = window.matchMedia('(display-mode: standalone)')
    const onChange = () => setIsInstalled(standalone())
    mq.addEventListener('change', onChange)

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      mq.removeEventListener('change', onChange)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferred) return 'unavailable' as const
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    // The event is single-use; Chromium re-fires it if the user declines.
    setDeferred(null)
    return outcome
  }, [deferred])

  return {
    canPrompt: deferred !== null,
    isInstalled,
    platform: detectPlatform(),
    browser: detectBrowser(),
    promptInstall,
  }
}
