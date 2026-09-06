import { GitRelayError, asGitRelayError } from './errors'

const API = 'https://api.github.com'

export interface RepoRef {
  owner: string
  repo: string
}

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
  const detail = apiMessage || raw || `HTTP ${res.status}`

  if (res.status === 401) {
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
    return new GitRelayError('conflict', 'The branches have conflicts and cannot be merged automatically.', {
      detail,
      status: res.status,
    })
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

async function request<T>(
  token: string,
  path: string,
  subject: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      // Merge decisions must never be made from a cached response.
      cache: 'no-store',
    })
  } catch (err) {
    throw asGitRelayError(err)
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

export async function getRepo(token: string, ref: RepoRef): Promise<RepoInfo> {
  const data = await request<{
    full_name: string
    default_branch: string
    private: boolean
    permissions?: { push?: boolean; admin?: boolean }
  }>(token, `/repos/${ref.owner}/${ref.repo}`, `${ref.owner}/${ref.repo}`)
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    permissions: data.permissions,
  }
}

/** Confirms the token itself is valid, independently of any repository. */
export async function getViewer(token: string): Promise<{ login: string; avatarUrl: string }> {
  const data = await request<{ login: string; avatar_url: string }>(
    token,
    '/user',
    'your GitHub account',
  )
  return { login: data.login, avatarUrl: data.avatar_url }
}

export async function listBranches(token: string, ref: RepoRef): Promise<BranchRef[]> {
  const out: BranchRef[] = []
  // Paginate defensively; repositories with many branches are common.
  for (let page = 1; page <= 10; page++) {
    const batch = await request<{ name: string; commit: { sha: string } }[]>(
      token,
      `/repos/${ref.owner}/${ref.repo}/branches?per_page=100&page=${page}`,
      `${ref.owner}/${ref.repo}`,
    )
    out.push(...batch.map((b) => ({ name: b.name, sha: b.commit.sha })))
    if (batch.length < 100) break
  }
  return out
}

export async function getBranch(
  token: string,
  ref: RepoRef,
  branch: string,
): Promise<{ name: string; latest: CommitSummary }> {
  const data = await request<{ name: string; commit: ApiCommit }>(
    token,
    `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`,
    `branch "${branch}"`,
  )
  return { name: data.name, latest: toCommitSummary(data.commit) }
}

/**
 * Compares `head` against `base`. `aheadBy` counts commits on head that base
 * does not have, which is the "commits ahead of dev" the user cares about.
 */
export async function compareBranches(
  token: string,
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
    files?: { filename: string; status: string; additions: number; deletions: number }[]
    base_commit: { sha: string }
  }>(
    token,
    `/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
    `branch "${base}" or "${head}"`,
  )

  const files = (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
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
  token: string,
  ref: RepoRef,
  base: string,
  head: string,
  commitMessage: string,
): Promise<MergeResult | null> {
  const data = await request<{
    sha: string
    html_url: string
    commit: { message: string; author: { date?: string } | null }
  } | null>(token, `/repos/${ref.owner}/${ref.repo}/merges`, `branch "${base}"`, {
    method: 'POST',
    body: JSON.stringify({ base, head, commit_message: commitMessage }),
  })

  // 204 No Content means base already contained head; nothing was merged.
  if (!data) return null

  return {
    sha: data.sha,
    htmlUrl: data.html_url,
    message: data.commit.message.split('\n')[0],
    mergedAt: data.commit.author?.date ?? new Date().toISOString(),
  }
}
