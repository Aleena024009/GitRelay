/**
 * Validation for every value that reaches a GitHub API path or a link href.
 *
 * Two separate jobs are done here:
 *
 *  1. Repository owners, repository names and branch names are typed by the
 *     user and then interpolated into API paths. Without validation a name
 *     such as `../../users` walks out of the intended endpoint, so names are
 *     checked against GitHub's own rules *and* percent-encoded.
 *  2. URLs that arrive in API responses are attacker-influenced data as far as
 *     this app is concerned. A `javascript:` href from a hostile response must
 *     never reach the DOM, so links are filtered to https://github.com.
 */
import { GitRelayError } from './errors'

/** GitHub logins: alphanumeric and hyphens, no leading/trailing hyphen. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

/** Repository names: alphanumeric, hyphen, underscore, dot. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/** Control characters, which are forbidden in a git ref. */
const CONTROL = /[\x00-\x1f\x7f]/

/** Characters git itself rejects in a ref name. */
const REF_FORBIDDEN = /[\s~^:?*[\]\\]/

export function isValidOwner(value: string): boolean {
  return OWNER.test(value)
}

export function isValidRepo(value: string): boolean {
  return REPO.test(value) && value !== '.' && value !== '..'
}

/**
 * Git's own reference rules (git-check-ref-format), restricted to the parts
 * that matter for a branch name reaching a URL path.
 */
export function isValidBranch(value: string): boolean {
  if (!value || value.length > 255) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false
  if (value.startsWith('.') || value.endsWith('.')) return false
  if (value.includes('..') || value.includes('@{')) return false
  if (value.endsWith('.lock')) return false
  return !REF_FORBIDDEN.test(value) && !CONTROL.test(value)
}

export interface RepoRef {
  owner: string
  repo: string
}

/**
 * Builds the `/repos/{owner}/{repo}` prefix. Validates first so a rejected
 * name never reaches the network, then encodes so even an accepted name
 * cannot introduce a path segment.
 */
export function repoPath(ref: RepoRef): string {
  if (!isValidOwner(ref.owner)) {
    throw new GitRelayError(
      'invalid_input',
      `"${ref.owner}" is not a valid GitHub owner name. Use only letters, numbers and hyphens.`,
    )
  }
  if (!isValidRepo(ref.repo)) {
    throw new GitRelayError(
      'invalid_input',
      `"${ref.repo}" is not a valid repository name. Use only letters, numbers, hyphens, underscores and dots.`,
    )
  }
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
}

/** Throws unless `branch` is a name git itself would accept. */
export function assertBranch(branch: string): void {
  if (!isValidBranch(branch)) {
    throw new GitRelayError('invalid_input', `"${branch}" is not a valid branch name.`)
  }
}

/** Validates a branch name and returns it encoded for use in a path. */
export function branchSegment(branch: string): string {
  assertBranch(branch)
  return encodeURIComponent(branch)
}

const LINK_HOSTS = new Set(['github.com', 'www.github.com', 'gist.github.com'])

/**
 * Filters a URL for use in an href. Returns null for anything that is not an
 * https:// GitHub page, so a hostile `javascript:` or off-site URL in an API
 * response cannot be turned into a link. Callers render nothing on null.
 */
export function safeGitHubUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (!LINK_HOSTS.has(url.hostname.toLowerCase())) return null
  return url.toString()
}

/** Builds a github.com link from validated parts, never from raw input. */
export function repoHtmlUrl(ref: RepoRef): string | null {
  if (!isValidOwner(ref.owner) || !isValidRepo(ref.repo)) return null
  return `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
}

/** Builds the compare page link for two validated branch names. */
export function compareHtmlUrl(ref: RepoRef, base: string, head: string): string | null {
  const root = repoHtmlUrl(ref)
  if (!root || !isValidBranch(base) || !isValidBranch(head)) return null
  return `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
}

/** Builds the branch page link for a validated branch name. */
export function branchHtmlUrl(ref: RepoRef, branch: string): string | null {
  const root = repoHtmlUrl(ref)
  if (!root || !isValidBranch(branch)) return null
  return `${root}/tree/${encodeURIComponent(branch)}`
}
