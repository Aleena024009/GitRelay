import { useState, type FormEvent } from 'react'
import { verifyToken } from '../lib/github'
import { asGitRelayError, GitRelayError } from '../lib/errors'
import { ErrorNotice } from './Notice'

interface SignInProps {
  onSignedIn: (token: string, login: string) => void
}

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export function SignIn({ onSignedIn }: SignInProps) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GitRelayError | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      // Verify before storing, so a bad paste never becomes a saved token.
      const viewer = await verifyToken(trimmed)
      onSignedIn(trimmed, viewer.login)
    } catch (err) {
      setError(asGitRelayError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Connect to GitHub</h2>
      </div>
      <p className="hint">
        GitRelay runs entirely in your browser with no server of its own, so it uses a GitHub
        access token that you provide. GitRelay has no backend and never uploads your token
        anywhere: it is sent only to <span className="mono">api.github.com</span>.
      </p>
      <ul className="hint security-facts">
        <li>Kept for this tab or app window only, and erased when you close it.</li>
        <li>Never written to long-term browser storage, and never put in a URL.</li>
        <li>Signing out removes it immediately.</li>
      </ul>

      <form className="form gap-top" onSubmit={submit}>
        {error ? <ErrorNotice error={error} /> : null}

        <div className="field-group">
          <label htmlFor="token">Fine-grained personal access token</label>
          <input
            id="token"
            type="password"
            className="mono"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="hint">
            <a href={TOKEN_URL} target="_blank" rel="noreferrer noopener">
              Create one on GitHub
            </a>{' '}
            with access limited to the single repository you consolidate, and only these
            permissions: <strong>Contents: Read and write</strong> and{' '}
            <strong>Metadata: Read-only</strong>. Adding <strong>Pull requests: Read-only</strong>{' '}
            is optional and shows GitHub's own mergeability answer for your release. A private
            repository must be selected explicitly in the token's repository list. Grant{' '}
            <strong>Only select repositories</strong>, never <em>All repositories</em>, and set a
            short expiry.
          </span>
        </div>

        <button type="submit" className="primary block" disabled={!token.trim() || busy}>
          {busy ? (
            <span className="btn-inner"><span className="spinner" /> Verifying…</span>
          ) : (
            'Continue'
          )}
        </button>
      </form>
    </div>
  )
}
