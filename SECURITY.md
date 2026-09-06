# Security

GitRelay holds a GitHub personal access token that can read and write real
repositories, including private ones. This document says what protects it,
what does not, and which weaknesses are structural rather than oversights.

## Assets

| Asset | Why it matters |
| --- | --- |
| The GitHub PAT | Grants whatever the token was scoped to — private repository contents, branch writes, merges |
| Private repository contents | Readable through the token; commit messages, file names and diffs pass through the UI |
| Repository write access | The token can create merge commits on the branches it can reach |
| The deployed site | Anyone who can change what is served at the app's URL can change what the app does with the token |

## Where the token lives

`sessionStorage`, under `gitrelay.token.v1`, written and read **only** by
[`src/lib/auth.ts`](src/lib/auth.ts). Nothing else in the codebase touches
token storage.

- It is **never** written to `localStorage`. Earlier builds offered "keep me
  signed in" and did; that feature is gone, and any token an old build left
  behind is deleted on first load of the new one.
- It never enters React state or props. `App` tracks only a boolean for
  "signed in"; the API client reads the token itself when it builds a request.
  A React devtools inspection of any component shows no token.
- It is never placed in a URL, query string, hash fragment, request body, DOM
  attribute, `IndexedDB`, Cache Storage or a cookie.
- Signing out, and any `401` from GitHub, delete it immediately.
- It is sent to exactly one origin: `https://api.github.com`.

## Threats

### 1. Same-origin exposure on GitHub Pages — *the most serious limitation*

GitHub Pages project sites share **one browser origin**:

```
https://<user>.github.io/GitRelay/                 ← GitRelay
https://<user>.github.io/SomeOtherProject/         ← same origin
https://<user>.github.io/AnotherProject/           ← same origin
```

`localStorage` and `sessionStorage` are keyed by **origin**. The path is not
part of the key. Serving GitRelay from `/GitRelay/` therefore provides **no
storage isolation whatsoever** from the account's other project pages.

Any script running on any of those sibling pages can read
`sessionStorage.getItem('gitrelay.token.v1')` — the same tab, the same origin,
the same storage. A cross-site scripting flaw in an unrelated hobby project
published under the same account is enough to steal the token. An outdated
jQuery on a neighbouring page is a realistic route to exactly that.

**What is done about it:** `sessionStorage` instead of `localStorage`, so the
token exists only while the tab is open rather than indefinitely, which
narrows the window considerably. It does **not** close the hole.

**The real fix — not available on GitHub Pages:** host GitRelay on a dedicated
origin. A custom domain (`gitrelay.example.com`) or any host that serves
nothing else gives genuine storage isolation, and lets real HTTP security
headers be set. Until then, treat every other page published under the same
`github.io` account as part of GitRelay's trust boundary.

One narrowing that *is* real: `github.io` is on the Public Suffix List, so
another **user's** `*.github.io` site cannot read this account's storage. The
exposure is limited to pages published by the same account.

**Related, lower severity:** repository configuration — owner, repository and
branch names — is kept in `localStorage` under `gitrelay.config.v1` so it
survives between sessions. It is not a credential, but on a shared origin a
sibling page can read it and learn the *name* of a private repository. This is
accepted deliberately: moving it to `sessionStorage` would force reconfiguration
on every visit without protecting the token, which is the asset that matters.
A dedicated origin removes this too.

### 2. Cross-site scripting

React escapes interpolated values, and the codebase contains no
`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, `eval` or `new Function`. Everything GitHub returns — branch
names, commit messages, author names, error bodies — is treated as untrusted
and rendered as text. `src/components/xss.test.tsx` pushes hostile payloads
through the rendering paths and asserts they never become markup.

URLs that arrive in API responses are filtered by `safeGitHubUrl` before being
used as an `href`, so a `javascript:` URL in a hostile response cannot become
a link.

### 3. Token exfiltration to a third party

The API client resolves every path against `https://api.github.com` and
re-checks the resulting origin before attaching the Authorization header, and
refuses to read a response that was redirected off that origin. The Content
Security Policy independently restricts `connect-src` to `api.github.com`, so
even a code defect cannot open a connection elsewhere. Requests are sent with
`credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.

### 4. Malicious or compromised dependencies

Runtime dependencies are React and React DOM only. There is no UI framework,
no GitHub SDK, no analytics, no CDN and no external font. The CSP forbids
loading script from anywhere but the app's own origin, so an injected
third-party `<script src>` will not execute.

`npm audit` reports **0 vulnerabilities**, production and development alike.
The build toolchain (Vite, Vitest, the PWA plugin, the React plugin) is on
current majors; the previous versions carried dev-server advisories that never
shipped to users but did expose the developer's own machine.

### 5. Accidental credential commits

`dist/` is git-ignored. `test/build-output.test.ts` scans everything that ships
for token-shaped strings on every test run. The full git history has been
scanned for PAT, OAuth-token and private-key patterns; the only match is the
input placeholder `github_pat_…`.

If a real credential is ever committed: **revoke it first** at
<https://github.com/settings/tokens>, then remove it from the working tree,
then rewrite history (`git filter-repo`) and force-push, then confirm the old
credential is rejected. Deleting it from the latest commit alone leaves it
readable in history and in every clone and fork.

### 6. Compromised deployment

The app is served by GitHub Pages from the `main` branch. Anyone who can push
to `main` can change what the app does with the token. Protecting that branch
and the deploy workflow is part of protecting the token.

### 7. Browser extensions

An extension with host access to the page can read its storage and its DOM.
Nothing a web app does prevents this. Out of scope, and stated rather than
implied.

## Content Security Policy

Injected into the built `index.html` at build time
([`vite.config.ts`](vite.config.ts)):

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
font-src 'self'; connect-src https://api.github.com; manifest-src 'self';
worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Deny by default. No `unsafe-inline`, no `unsafe-eval`, no wildcards, no
third-party origin. The app ships no inline script and no inline style — the
handful of style attributes it used were converted to classes specifically so
`style-src` could stay strict.

The policy is applied to production builds only; the dev server needs inline
scripts and a websocket for hot reload, and weakening the shipped policy to
accommodate development would defeat its purpose.

## Headers that cannot be set on GitHub Pages

GitHub Pages serves static files and allows no response-header configuration.
A `<meta http-equiv>` CSP is **not** equivalent to a header, and the following
protections are genuinely unavailable here:

| Protection | Status |
| --- | --- |
| `Content-Security-Policy` | Set via `<meta>`. Works, but applies only after the HTML starts parsing, and cannot be enforced on non-HTML responses |
| `frame-ancestors` | **Not available.** Browsers ignore it in `<meta>`. Deliberately omitted rather than included for appearance |
| `X-Frame-Options` | **Not available.** Header-only — so GitRelay can be framed, and clickjacking cannot be prevented on this host |
| `X-Content-Type-Options: nosniff` | **Not available.** Header-only |
| `Permissions-Policy` | **Not available.** Header-only |
| `Referrer-Policy` | Approximated by `<meta name="referrer" content="no-referrer">`, and set per-request on every API call |
| `Strict-Transport-Security` | Provided by GitHub for `*.github.io` |

Every one of these becomes available on a dedicated origin behind a host that
can set headers.

## Token permissions — least privilege

Use a **fine-grained** personal access token, never a classic one. A classic
token with the `repo` scope reaches every repository the account can see,
public and private, and cannot be narrowed.

| Setting | Value |
| --- | --- |
| Repository access | **Only select repositories** → the one repository |
| Contents | Read and write — reading branches, comparing, merging |
| Metadata | Read-only (mandatory) |
| Pull requests | Read-only, optional — only to show GitHub's mergeability verdict |

Set the shortest expiry that is practical. GitRelay reports expiry clearly and
asks for a new token.

## Reporting

Open a private security advisory on the repository. Please do not open a
public issue for anything that would expose a token.
