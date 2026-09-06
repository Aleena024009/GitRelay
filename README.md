# GitRelay

A small PWA for one job: consolidating developer branches into `dev`, then releasing `dev` to `main` — deliberately, one branch at a time.

```
developer branches  →  select ONE  →  dev  →  (verify)  →  explicitly release  →  main
```

It is not a GitHub client. There is no issue tracker, no repository browser, no CI dashboard.

## What it does

- Lists only the developer branches you configure, with commits ahead/behind `dev`, the latest commit, and whether it can merge cleanly.
- Merges a branch into `dev` in two clicks, after showing you the commits, files, and line counts that will land.
- Releases `dev` into `main` as a completely separate, explicit action.
- Refuses to merge when GitHub reports a conflict, and tells you plainly that nothing was changed.

## What it will never do

- Merge branches you did not select, or merge "all" branches.
- Promote `dev` to `main` automatically after a developer merge.
- Delete, modify, or force-push any branch.
- Rewrite history or resolve conflicts on your behalf.

Every write GitRelay makes is a single `POST /repos/{owner}/{repo}/merges` call, which creates an ordinary merge commit on the target branch and touches nothing else. GitHub performs the merge server-side and makes no change at all when it would conflict.

## Authentication

GitRelay is a static site on GitHub Pages with no backend of its own. That rules out an OAuth flow: an OAuth app's token exchange needs a client secret with nowhere safe to live, and GitHub's device-flow endpoints do not send CORS headers a browser can use. Both would require running a server.

So you supply a **fine-grained personal access token** at runtime. It is stored only in your browser (`localStorage`, or `sessionStorage` if you untick "keep me signed in") and is sent only to `api.github.com`. No token is in the source, the repository, or the build.

Create one at **Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)** with:

| Setting | Value |
| --- | --- |
| Repository access | Only select repositories → *your repo* |
| Contents | **Read and write** |
| Metadata | **Read-only** (mandatory, added automatically) |

Nothing else. `Contents` covers reading branches, comparing them, and merging; `Metadata` covers looking up the repository. Set an expiry you are comfortable with — when it expires GitRelay says so and asks you to sign in again.

> If you later add a small backend or serverless function, you can swap in the OAuth device flow by replacing `src/lib/auth.ts` and the sign-in screen. Nothing else in the app assumes where the token came from.

## Setup

```bash
npm install
npm run dev
```

Open the app, paste your token, then in **Settings** set:

- **Repository** — owner and repository name. "Check access" verifies the token and loads real branch names into the pickers.
- **Development branch** — default `dev`.
- **Production branch** — default `main`.
- **Developer branches** — add, rename, or remove the branches you want to track. Nothing is added automatically; branch names are not assumed to be permanent.

Configuration lives in your browser, so each person using GitRelay configures their own.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`.

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds and deploys on every push to `main`. It derives the Vite `base` from the repository name, so the app works at `https://<owner>.github.io/<repo>/` without configuration (and at `/` for a `<owner>.github.io` repository).

To build locally for a subpath:

```bash
BASE_PATH=/GitRelay/ npm run build
npm run preview
```

## Installing as an app

The header carries three compact icon actions — **Refresh**, **Settings**, and **Download app**.

"Download app" installs GitRelay as a real application. Where the browser supports it (Chrome, Brave, Edge on Android, Windows, macOS, Linux and ChromeOS) it installs in one click; everywhere else the dialog shows the exact steps for that platform and browser, including Safari's "Add to Home Screen" on iOS and "Add to Dock" on macOS. If Firefox on desktop is in use it says plainly that installing is not supported there.

Installed, GitRelay runs in its own window with no address bar and appears in the app launcher or home screen. The app shell is cached for offline launch; GitHub API calls are explicitly never cached, so a merge is never decided from stale data.

## Interface

Mobile-first and responsive from 320 px upward: branch cards stack and their actions go full-width on phones, modals become bottom sheets, and every control meets a 44 px touch target. Nothing on any screen scrolls horizontally.

## How mergeability is determined

GitHub has no read-only "would this merge?" endpoint that does not create a pull request, so GitRelay does not pretend otherwise:

- **`✓ Ready to merge`** — `dev` has no commits the branch is missing. The merge fast-forwards and *cannot* conflict.
- **`Diverged`** — both branches moved. The confirmation dialog says so, and GitHub does the real conflict check when you confirm. If it conflicts, the merge is rejected and nothing changes.
- **`Nothing to merge`** — the branch holds no commits that `dev` lacks. Deliberately not labelled "up to date", since such a branch is often far *behind* `dev`; the ↑/↓ counters show both directions.

Immediately before writing, GitRelay re-reads both branch tips. If either moved while the dialog was open, it stops, tells you, and reloads the summary rather than merging against a stale preview.

## Project layout

```
src/
  lib/github.ts    GitHub REST client + error mapping
  lib/errors.ts    error kinds with user-facing messages
  lib/status.ts    branch readiness model
  lib/config.ts    repository / branch configuration
  lib/auth.ts      token storage (browser only)
  components/      SignIn, Settings, BranchRow, MergeModal, Modal, Notice
  App.tsx          main screen
```

React + TypeScript + Vite + `vite-plugin-pwa`. No UI framework, no GitHub SDK; ~56 KB gzipped.
