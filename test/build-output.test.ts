/**
 * Assertions about what actually ships. These read `dist/`, so they only mean
 * something after `npm run build`; `npm run verify` runs the build first.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIST = join(process.cwd(), 'dist')
const built = existsSync(DIST)

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? allFiles(full) : [full]
  })
}

const TOKEN_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9]{10,}_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

describe.skipIf(!built)('no secrets in the shipped bundle', () => {
  it('contains nothing token-shaped', () => {
    const offenders: string[] = []
    for (const file of allFiles(DIST)) {
      const text = readFileSync(file, 'utf8')
      for (const shape of TOKEN_SHAPES) {
        if (shape.test(text)) offenders.push(`${file} :: ${shape}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe.skipIf(!built)('service worker', () => {
  const sw = built && existsSync(join(DIST, 'sw.js')) ? readFileSync(join(DIST, 'sw.js'), 'utf8') : ''

  it('routes the GitHub API to NetworkOnly so responses are never persisted', () => {
    // Workbox emits the route as an escaped regex literal, so match loosely
    // on the host and strictly on the handler.
    expect(sw).toMatch(/api\\?\.github\\?\.com/)
    expect(sw).toMatch(/NetworkOnly/)
  })

  it('does not precache anything from the GitHub API', () => {
    const precache = sw.match(/precacheAndRoute\(\[[\s\S]*?\]/)?.[0] ?? ''
    expect(precache).not.toBe('')
    expect(precache).not.toMatch(/github\.com/)
    expect(precache).not.toMatch(/\/repos\//)
  })

  it('cleans up caches left by earlier versions', () => {
    expect(sw).toMatch(/cleanupOutdatedCaches/)
  })
})

describe.skipIf(!built)('content security policy', () => {
  const html = built ? readFileSync(join(DIST, 'index.html'), 'utf8') : ''
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''

  it('is present in the shipped page', () => {
    expect(csp).not.toBe('')
  })

  it('denies by default and allows no third-party origin', () => {
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
  })

  it('permits network access to GitHub and nowhere else', () => {
    const connect = csp.match(/connect-src ([^;]+)/)?.[1].trim()
    expect(connect).toBe('https://api.github.com')
  })

  it('allows no inline or remote script, and no inline style', () => {
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/script-src[^;]*\*/)
  })

  it('has no inline script or style element to permit', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html).not.toMatch(/<style[\s>]/)
    expect(html).not.toMatch(/\sstyle="/)
  })
})
