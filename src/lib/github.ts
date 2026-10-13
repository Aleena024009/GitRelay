/**
 * The only module that talks to GitHub, and the only one that reads the token.
 *
 * Every request is built here, so there is exactly one place where the
 * Authorization header is attached and exactly one destination it can be
 * attached to. Callers pass repository and branch names; they never see or
 * hold the token, which keeps it out of React props, component state and
 * anything that inspects them.
 */
import { GitRelayError, asGitRelayError } from './errors'
import { clearToken, loadToken } from './auth'
import { assertBranch, branchSegment, repoPath, type RepoRef } from './validate'

/** The single origin credentials may ever be sent to. */
const API_ORIGIN = 'https://api.github.com'

export type { RepoRef }

export interface CommitSummary {
  sha: string
  message: string
  authorName: string
  date: string
}

export interface ChangedFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** The path this file had before, when GitHub detected a rename. */
  previousFilename?: string
}

/** Result of `base...head`, i.e. how `head` relates to `base`. */
export interface Comparison {
  status: 'identical' | 'ahead' | 'behind' | 'diverged'
  aheadBy: number
  behindBy: number
  totalCommits: number
  commits: CommitSummary[]
  files: ChangedFile[]
  /** GitHub caps the compare file list at 300 entries. */
  filesTruncated: boolean
  additions: number
  deletions: number
  /** The base ref's commit at the time of the comparison. */
  baseSha: string
}

export interface BranchRef {
  name: string
  sha: string
}

export interface MergeResult {
  /**
   * `merge` wrote a new merge commit on the target; `fast-forward` moved the
   * target to a commit the source already had, so no commit was created.
   */
  kind: 'merge' | 'fast-forward'
  sha: string
  htmlUrl: string
  message: string
  mergedAt: string
}

interface ApiCommit {
  sha: string
  commit: { message: string; author: { name?: string; date?: string } | null }
}

function toCommitSummary(c: ApiCommit): CommitSummary {
  return {
    sha: c.sha,
    message: c.commit.message.split('\n')[0],
    authorName: c.commit.author?.name ?? 'unknown',
    date: c.commit.author?.date ?? '',
  }
}

/**
 * Removes anything token-shaped from text before it is shown or kept.
 *
 * GitHub does not echo credentials back, but error text is the one path that
 * carries raw bytes from a response into the UI, so it is filtered rather than
 * trusted. Exported so tests can assert the guarantee directly.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted token]')
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, '[redacted token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/("?authorization"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1[redacted]')
}

/**
 * Turns a non-OK GitHub response into an error whose message can be shown
 * as-is. `subject` names the thing being acted on so 404s can be specific.
 */
async function toError(res: Response, subject: string): Promise<GitRelayError> {
  let raw = ''
  let apiMessage = ''
  try {
    raw = await res.text()
    apiMessage = (JSON.parse(raw) as { message?: string }).message ?? ''
  } catch {
    /* body was empty or not JSON; raw text is enough for the details pane */
  }
  const detail = redactSecrets(apiMessage || raw || `HTTP ${res.status}`)

  if (res.status === 401) {
    // The stored token is no longer usable, so it is dropped immediately
    // rather than left in storage for the next tab to pick up.
    clearToken()
    return new GitRelayError(
      'auth',
      'GitHub rejected your access token. It may have expired or been revoked — sign in again with a new token.',
      { detail, status: res.status },
    )
  }

  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      const when = Number.isFinite(reset)
        ? new Date(reset * 1000).toLocaleTimeString()
        : 'shortly'
      return new GitRelayError(
        'rate_limit',
        `GitHub's API rate limit has been reached. Requests will work again at about ${when}.`,
        { detail, status: res.status },
      )
    }
    return new GitRelayError(
      'permission',
      `Your token does not have permission to do that on this repository. It needs Contents: Read and write access to ${subject}.`,
      { detail, status: res.status },
    )
  }

  if (res.status === 404) {
    return new GitRelayError(
      'not_found',
      `${subject} was not found. Check the owner, repository and branch names in Settings, and confirm your token can access this repository.`,
      { detail, status: res.status },
    )
  }

  if (res.status === 409) {
    // A 409 is not always a conflict. GitHub answers a merge it will not make
    // with this same status — a protected branch, a repository ruleset that
    // requires a pull request — and calling those a "conflict" sends people
    // hunting for conflicting changes that do not exist. Only GitHub's own
    // "Merge conflict" answer is reported as one.
    if (/merge conflict/i.test(apiMessage)) {
      return new GitRelayError('conflict', 'The branches have conflicts and cannot be merged automatically.', {
        detail,
        status: res.status,
      })
    }
    const reason = apiMessage.replace(/\s+/g, ' ').trim() || `HTTP ${res.status}.`
    if (/protected branch|rule/i.test(apiMessage)) {
      return new GitRelayError(
        'protected_branch',
        `GitHub refused this merge — ${reason} Nothing was changed. This is a rule on the target branch (branch protection or a repository ruleset), not a conflict between the branches.`,
        { detail, status: res.status },
      )
    }
    return new GitRelayError(
      'refused',
      `GitHub refused this merge — ${reason} Nothing was changed. GitHub did not report a conflict between the branches.`,
      { detail, status: res.status },
    )
  }

  if (res.status === 422) {
    // The ref endpoint answers 422 when a non-forced update would lose commits
    // on the target. That is the whole point of asking for a fast-forward, so
    // it is reported as divergence, never retried as a force.
    if (/fast[\s-]?forward/i.test(apiMessage)) {
      return new GitRelayError(
        'diverged',
        `${subject} has commits the other branch does not, so it cannot simply be moved forward. Nothing was changed.`,
        { detail, status: res.status },
      )
    }
    if (/protected/i.test(apiMessage)) {
      const reason = apiMessage.replace(/\s+/g, ' ').trim()
      return new GitRelayError(
        'protected_branch',
        `GitHub refused to update ${subject} — ${reason} Nothing was changed. This is a branch protection rule, not a problem with the branches themselves.`,
        { detail, status: res.status },
      )
    }
  }

  if (res.status >= 500) {
    return new GitRelayError('network', 'GitHub is having trouble right now. Try again in a moment.', {
      detail,
      status: res.status,
    })
  }

  return new GitRelayError('unknown', `GitHub could not complete that request (${subject}).`, {
    detail,
    status: res.status,
  })
}

interface RequestOptions {
  method?: string
  body?: unknown
  /**
   * Sign-in only. A candidate token is checked against GitHub before it is
   * ever written to storage, so that one call has to carry it explicitly.
   * Every other request reads the stored token itself.
   */
  token?: string
}

async function request<T>(path: string, subject: string, opts: RequestOptions = {}): Promise<T> {
  const token = opts.token ?? loadToken()
  if (!token) {
    throw new GitRelayError('auth', 'You are not signed in. Enter a GitHub token to continue.')
  }

  // Pin the destination. Paths are built inside this module, but resolving
  // against a fixed origin and re-checking means no later edit — and no value
  // that reaches a path — can aim an authenticated request at another host.
  const url = new URL(path, API_ORIGIN)
  if (url.origin !== API_ORIGIN) {
    throw new GitRelayError(
      'unknown',
      'Refused to send your token to an unexpected host. This is a bug in GitRelay, not a problem with your repository.',
    )
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      // Merge decisions must never be made from a cached response.
      cache: 'no-store',
      // The token is the only credential; cookies must never ride along.
      credentials: 'omit',
      // Never disclose which page is calling.
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    })
  } catch (err) {
    throw asGitRelayError(err)
  }

  // The browser strips Authorization across a cross-origin redirect, so a
  // response from elsewhere is not an authenticated answer to our request and
  // its body is not trusted.
  if (res.url && new URL(res.url).origin !== API_ORIGIN) {
    throw new GitRelayError(
      'unknown',
      'GitHub redirected this request off api.github.com. Nothing was read from the response.',
    )
  }

  if (!res.ok) throw await toError(res, subject)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface RepoInfo {
  fullName: string
  defaultBranch: string
  private: boolean
  permissions?: { push?: boolean; admin?: boolean }
}

export async function getRepo(ref: RepoRef): Promise<RepoInfo> {
  const slug = `${ref.owner}/${ref.repo}`
  const data = await request<{
    full_name: string
    default_branch: string
    private: boolean
    permissions?: { push?: boolean; admin?: boolean }
  }>(repoPath(ref), slug).catch((err: unknown) => {
    // GitHub answers 404 rather than 403 for private repositories a token
    // cannot see, so a "missing" repo is usually really a missing grant.
    if (err instanceof GitRelayError && err.kind === 'not_found') {
      throw new GitRelayError(
        'not_found',
        `Could not open ${slug}. Either the name is wrong, or — if the repository is private — your token has not been granted access to it. Open the token on GitHub, set Repository access to "Only select repositories", and add ${slug}.`,
        { detail: err.detail, status: err.status },
      )
    }
    throw err
  })
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    permissions: data.permissions,
  }
}

/**
 * Confirms a candidate token is valid before it is stored. This is the only
 * function that accepts a token argument; nothing here writes it anywhere.
 */
export async function verifyToken(candidate: string): Promise<{ login: string }> {
  const data = await request<{ login: string }>('/user', 'your GitHub account', {
    token: candidate,
  })
  return { login: data.login }
}

export async function listBranches(ref: RepoRef): Promise<BranchRef[]> {
  const out: BranchRef[] = []
  const base = repoPath(ref)
  // Paginate defensively; repositories with many branches are common.
  for (let page = 1; page <= 10; page++) {
    const batch = await request<{ name: string; commit: { sha: string } }[]>(
      `${base}/branches?per_page=100&page=${page}`,
      `${ref.owner}/${ref.repo}`,
    )
    out.push(...batch.map((b) => ({ name: b.name, sha: b.commit.sha })))
    if (batch.length < 100) break
  }
  return out
}

export async function getBranch(
  ref: RepoRef,
  branch: string,
): Promise<{ name: string; latest: CommitSummary }> {
  const data = await request<{ name: string; commit: ApiCommit }>(
    `${repoPath(ref)}/branches/${branchSegment(branch)}`,
    `branch "${branch}"`,
  )
  return { name: data.name, latest: toCommitSummary(data.commit) }
}

/**
 * Compares `head` against `base`. `aheadBy` counts commits on head that base
 * does not have, which is the "commits ahead of dev" the user cares about.
 */
export async function compareBranches(
  ref: RepoRef,
  base: string,
  head: string,
): Promise<Comparison> {
  const data = await request<{
    status: Comparison['status']
    ahead_by: number
    behind_by: number
    total_commits: number
    commits: ApiCommit[]
    files?: {
      filename: string
      status: string
      additions: number
      deletions: number
      previous_filename?: string
    }[]
    base_commit: { sha: string }
  }>(
    `${repoPath(ref)}/compare/${branchSegment(base)}...${branchSegment(head)}?per_page=100`,
    `branch "${base}" or "${head}"`,
  )

  const files = (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
  }))
  const commits = data.commits.map(toCommitSummary)

  return {
    status: data.status,
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    totalCommits: data.total_commits,
    commits,
    files,
    filesTruncated: files.length >= 300,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    baseSha: data.base_commit.sha,
  }
}

/**
 * Performs a real merge commit on `base`. GitHub does this server-side and
 * makes no change at all when the merge would conflict, so a 409 is safe.
 * `head` is never modified.
 */
export async function mergeBranch(
  ref: RepoRef,
  base: string,
  head: string,
  commitMessage: string,
): Promise<MergeResult | null> {
  // Validate both names even though they travel in the body rather than the
  // path: GitHub should never be asked to act on a ref this app rejects.
  assertBranch(base)
  assertBranch(head)

  const data = await request<{
    sha: string
    html_url: string
    commit: { message: string; author: { date?: string } | null }
  } | null>(`${repoPath(ref)}/merges`, `branch "${base}"`, {
    method: 'POST',
    body: { base, head, commit_message: commitMessage },
  })

  // 204 No Content means base already contained head; nothing was merged.
  if (!data) return null

  return {
    kind: 'merge',
    sha: data.sha,
    htmlUrl: data.html_url,
    message: data.commit.message.split('\n')[0],
    mergedAt: data.commit.author?.date ?? new Date().toISOString(),
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * Moves `branch` forward to `sha` without creating a commit.
 *
 * This is a plain ref update with `force: false`, so GitHub itself enforces
 * that `sha` descends from the branch's current tip: if the branch has any
 * commit `sha` does not contain — including one pushed a moment ago — the
 * update is refused with a `diverged` error and nothing changes. Passing the
 * exact SHA that was reviewed, rather than a branch name, means what lands is
 * precisely what the user saw.
 */
export async function fastForwardBranch(
  ref: RepoRef,
  branch: string,
  sha: string,
): Promise<MergeResult> {
  if (!FULL_SHA.test(sha)) {
    throw new GitRelayError('invalid_input', `"${sha}" is not a full commit SHA, so ${branch} was not moved.`)
  }

  const data = await request<{ object: { sha: string } }>(
    `${repoPath(ref)}/git/refs/heads/${branchSegment(branch)}`,
    `branch "${branch}"`,
    { method: 'PATCH', body: { sha, force: false } },
  )

  // GitHub answered, but not with the commit it was asked to point at; say so
  // rather than report a release that may not be what was reviewed.
  if (data.object.sha !== sha) {
    throw new GitRelayError(
      'unknown',
      `GitHub moved ${branch} to ${data.object.sha.slice(0, 7)} rather than ${sha.slice(0, 7)}. Refresh and check the branch on GitHub.`,
    )
  }

  const repoSlug = `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
  return {
    kind: 'fast-forward',
    sha,
    htmlUrl: `https://github.com/${repoSlug}/commit/${sha}`,
    message: '',
    mergedAt: new Date().toISOString(),
  }
}

/* --------------------------------------------------------------------------
 * Mergeability
 *
 * GitHub only ever computes "would these two branches merge?" in the context
 * of a pull request, and that computed answer is precisely what its web
 * interface shows on the pull request and compare pages. GitRelay reads that
 * answer when a pull request already exists and never opens one to find out,
 * so asking the question stays a read.
 * ------------------------------------------------------------------------ */

const MERGEABLE_STATES = [
  'clean',
  'dirty',
  'blocked',
  'behind',
  'unstable',
  'draft',
  'has_hooks',
  'unknown',
] as const

export type MergeableState = (typeof MERGEABLE_STATES)[number]

function toMergeableState(raw: string | undefined): MergeableState {
  return (MERGEABLE_STATES as readonly string[]).includes(raw ?? '')
    ? (raw as MergeableState)
    : 'unknown'
}

export interface PullSummary {
  number: number
  htmlUrl: string
  title: string
  draft: boolean
}

/** What GitHub itself says about merging `head` into `base`, right now. */
export type Mergeability =
  /** GitHub has test-merged the branches and they do not conflict. */
  | { kind: 'mergeable'; state: MergeableState; pull: PullSummary }
  /** GitHub has test-merged the branches and they conflict. */
  | { kind: 'conflicting'; state: MergeableState; pull: PullSummary }
  /** A pull request exists but GitHub had not finished testing it in time. */
  | { kind: 'computing'; pull: PullSummary }
  /** No open pull request, so GitHub has no computed answer to read. */
  | { kind: 'no_pull_request' }
  /** The answer could not be read; `reason` explains why, in plain words. */
  | { kind: 'unavailable'; reason: string }

/** The open pull request for `head` → `base`, if the user has one. */
export async function findOpenPullRequest(
  ref: RepoRef,
  base: string,
  head: string,
): Promise<PullSummary | null> {
  // URLSearchParams escapes the values itself, so these are validated for
  // shape rather than encoded here; an invalid ref must still never be asked
  // about.
  assertBranch(base)
  assertBranch(head)
  const query = new URLSearchParams({
    state: 'open',
    base,
    // Same-repository branches only; a fork's branch is not what we merge.
    head: `${ref.owner}:${head}`,
    per_page: '1',
  })
  const list = await request<
    { number: number; html_url: string; title: string; draft?: boolean }[]
  >(`${repoPath(ref)}/pulls?${query.toString()}`, `pull requests in ${ref.owner}/${ref.repo}`)
  const pull = list[0]
  if (!pull) return null
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    title: pull.title,
    draft: pull.draft ?? false,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads GitHub's own mergeability verdict for `head` → `base`.
 *
 * This never writes: with no open pull request it reports `no_pull_request`
 * rather than opening one, and a token that cannot read pull requests yields
 * `unavailable` rather than an error, since neither is a failure of the merge.
 */
export async function getMergeability(
  ref: RepoRef,
  base: string,
  head: string,
  { attempts = 4, delayMs = 800 }: { attempts?: number; delayMs?: number } = {},
): Promise<Mergeability> {
  try {
    const pull = await findOpenPullRequest(ref, base, head)
    if (!pull) return { kind: 'no_pull_request' }

    // GitHub computes `mergeable` in the background and answers null until the
    // background job lands, so a null is "ask again", never "cannot merge".
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(delayMs)
      const data = await request<{ mergeable: boolean | null; mergeable_state?: string }>(
        `${repoPath(ref)}/pulls/${encodeURIComponent(String(pull.number))}`,
        `pull request #${pull.number}`,
      )
      if (data.mergeable === null) continue
      const state = toMergeableState(data.mergeable_state)
      return data.mergeable
        ? { kind: 'mergeable', state, pull }
        : { kind: 'conflicting', state, pull }
    }
    return { kind: 'computing', pull }
  } catch (err) {
    const e = asGitRelayError(err)
    if (e.kind === 'permission' || e.kind === 'not_found') {
      return {
        kind: 'unavailable',
        reason:
          'Your token cannot read this repository’s pull requests. Add "Pull requests: Read" to it to see GitHub’s own mergeability answer here.',
      }
    }
    return { kind: 'unavailable', reason: e.message }
  }
}
