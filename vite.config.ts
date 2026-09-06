import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages project sites are served from /<repo>/, so the bundle needs a
// matching base path. The deploy workflow sets BASE_PATH from GITHUB_REPOSITORY;
// local dev and user-hosted deployments fall back to root.
const base = process.env.BASE_PATH ?? '/'


/**
 * Content Security Policy, injected into the built index.html only.
 *
 * It is deliberately deny-by-default and lists exactly what GitRelay loads:
 * one same-origin module script, one same-origin stylesheet, same-origin
 * icons and manifest, one same-origin service worker, and network access to
 * api.github.com and nowhere else. There are no inline scripts, no inline
 * styles, no web fonts, no data: URIs and no third-party origins, so none of
 * those need to be allowed.
 *
 * Two limits are worth stating rather than hiding:
 *
 *  - `frame-ancestors` is deliberately absent. Browsers ignore it in a <meta>
 *    policy, and GitHub Pages cannot set response headers, so clickjacking
 *    protection is genuinely unavailable on this host. See SECURITY.md.
 *  - This is applied at build time only. The dev server needs inline scripts
 *    and a websocket for hot reload, and weakening the shipped policy to suit
 *    development would defeat the point.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src https://api.github.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy() {
  return {
    name: 'gitrelay-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

export default defineConfig({
  base,
  plugins: [
    contentSecurityPolicy(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'GitRelay',
        short_name: 'GitRelay',
        description: 'Controlled GitHub branch consolidation: developer branch to dev to main.',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // The app shell is cached for offline launch. GitHub API traffic is
        // deliberately never cached: merge decisions must always use live state.
        navigateFallback: `${base}index.html`.replace('//', '/'),
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.github\.com\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
})
