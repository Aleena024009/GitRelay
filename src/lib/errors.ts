export type ErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'invalid_input'
  | 'branch_missing'
  | 'network'
  | 'rate_limit'
  | 'conflict'
  | 'diverged'
  | 'protected_branch'
  | 'stale'
  | 'nothing_to_do'
  | 'unknown'

/**
 * An error that already carries a message safe to show a user directly.
 * Raw API text is kept in `detail` for the expandable "View details" section
 * so the primary UI never has to surface it.
 */
export class GitRelayError extends Error {
  readonly kind: ErrorKind
  readonly detail?: string
  readonly status?: number

  constructor(kind: ErrorKind, message: string, opts: { detail?: string; status?: number } = {}) {
    super(message)
    this.name = 'GitRelayError'
    this.kind = kind
    this.detail = opts.detail
    this.status = opts.status
  }
}

export function asGitRelayError(err: unknown): GitRelayError {
  if (err instanceof GitRelayError) return err
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError when the request never reached GitHub.
    return new GitRelayError(
      'network',
      'Could not reach GitHub. Check your internet connection and try again.',
      { detail: err.message },
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return new GitRelayError('unknown', 'Something went wrong talking to GitHub.', {
    detail: message,
  })
}
