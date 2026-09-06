import { useState } from 'react'
import { Modal } from './Modal'
import { Notice } from './Notice'
import { DownloadIcon } from './Icons'
import type { Browser, Platform } from '../lib/install'

interface InstallModalProps {
  platform: Platform
  browser: Browser
  canPrompt: boolean
  isInstalled: boolean
  onInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
  onClose: () => void
}

interface Guide {
  label: string
  steps: string[]
  /** Set when the browser simply cannot install a PWA. */
  unsupported?: string
}

const PLATFORM_NAME: Record<Platform, string> = {
  android: 'Android',
  ios: 'iPhone / iPad',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  unknown: 'this device',
}

function guideFor(platform: Platform, browser: Browser): Guide {
  if (platform === 'ios') {
    if (browser !== 'safari') {
      return {
        label: 'iPhone / iPad',
        steps: ['Open this page in Safari — iOS only allows Safari to add apps to the Home Screen.'],
        unsupported: 'This browser cannot install apps on iOS.',
      }
    }
    return {
      label: 'iPhone / iPad — Safari',
      steps: ['Tap the Share button at the bottom of the screen.', 'Scroll down and tap "Add to Home Screen".', 'Tap "Add" in the top-right corner.'],
    }
  }

  if (platform === 'android') {
    if (browser === 'firefox') {
      return {
        label: 'Android — Firefox',
        steps: ['Open the ⋮ menu.', 'Tap "Add to Home screen".'],
      }
    }
    return {
      label: 'Android — Chrome, Brave or Edge',
      steps: ['Open the ⋮ menu in the top-right.', 'Tap "Add to Home screen" or "Install app".', 'Confirm with "Install".'],
    }
  }

  if (browser === 'firefox') {
    return {
      label: `${PLATFORM_NAME[platform]} — Firefox`,
      steps: ['Firefox on desktop cannot install web apps. Use Chrome, Brave, Edge or another Chromium browser, or simply keep GitRelay open in a pinned tab.'],
      unsupported: 'Firefox does not support installing web apps on desktop.',
    }
  }

  if (platform === 'macos' && browser === 'safari') {
    return {
      label: 'macOS — Safari',
      steps: ['Open the File menu.', 'Choose "Add to Dock".', 'Confirm with "Add".'],
    }
  }

  return {
    label: `${PLATFORM_NAME[platform]} — Chrome, Brave or Edge`,
    steps: ['Look for the install icon (a monitor with a downward arrow) at the right of the address bar, and click it.', 'If it is not there, open the ☰ or ⋮ menu and choose "Install GitRelay…" (in Brave it may sit under "More tools").', 'Confirm with "Install".'],
  }
}

export function InstallModal({
  platform,
  browser,
  canPrompt,
  isInstalled,
  onInstall,
  onClose,
}: InstallModalProps) {
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const guide = guideFor(platform, browser)

  async function install() {
    setBusy(true)
    const outcome = await onInstall()
    setBusy(false)
    if (outcome === 'accepted') onClose()
    if (outcome === 'dismissed') setDismissed(true)
  }

  return (
    <Modal
      title="Install GitRelay"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Close</button>
          {canPrompt && !isInstalled ? (
            <button className="primary" onClick={() => void install()} disabled={busy}>
              {busy ? <span className="btn-inner"><span className="spinner" /> Installing…</span>
                    : <span className="btn-inner"><DownloadIcon size={16} /> Install now</span>}
            </button>
          ) : null}
        </>
      }
    >
      {isInstalled ? (
        <Notice tone="success" title="Already installed">
          You are running GitRelay as an installed app on this device.
        </Notice>
      ) : (
        <>
          <p className="lede">
            GitRelay installs as a normal app: its own window or home-screen icon, no address
            bar, and the interface loads instantly even on a poor connection.
          </p>

          {canPrompt ? (
            <Notice tone="info" title="Ready to install here">
              Your browser can install GitRelay directly — use the button below.
            </Notice>
          ) : null}

          {dismissed ? (
            <Notice tone="info" title="Installation cancelled">
              Nothing was installed. You can start again whenever you like.
            </Notice>
          ) : null}

          {guide.unsupported ? (
            <Notice tone="warn" title={guide.unsupported} />
          ) : null}

          <div className="subhead">{guide.label}</div>
          <ol className="steps">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>

          <p className="muted small-text" style={{ marginBottom: 0 }}>
            Works on Android, Windows, macOS, Linux and ChromeOS. Your settings and access token
            stay in this browser profile, so an installed app shares them with this tab.
          </p>
        </>
      )}
    </Modal>
  )
}
